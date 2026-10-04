// Planlama: keşif, gereksinimler, şartname ve görev planı (Claude mühendis ya da Gemini), onay.
// (Orchestrator sınıfının yöntemleri; bkz. index.js — `this` orkestratördür.)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const settings = require('../settings');
const agents = require('../agents');
const project = require('../project');
const verify = require('../verify');
const docs = require('../docs');
const versions = require('../versions');
const P = require('../prompts');

class Planning {
  // ---------- planlama ----------
  startPlanning({ idea, projectDir, agent, attachments }) {
    if (this.running) throw new Error('Şu anda çalışan bir iş var. Önce durdurun.');
    if (!projectDir) throw new Error('Proje klasörü seçin.');
    const files = docs.sanitizeAttachments(attachments);
    if (!String(idea || '').trim() && !files.length) throw new Error('Bir istek yazın veya doküman ekleyin.');
    const s = settings.get();
    if (!s.geminiKey) throw new Error('Gemini API anahtarı yok. Ayarlar\'dan ekleyin.');
    const agentId = agents.ADAPTERS[agent] ? agent : s.defaultAgent;
    fs.mkdirSync(projectDir, { recursive: true });

    this.job = {
      id: `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
      idea: String(idea || '').trim(),
      projectDir,
      agent: agentId,
      attachments: files,
      createdAt: Date.now(),
      phase: 'planning',
      plan: null,
      tasks: [],
      stats: { agentRuns: 0, costUsd: 0, geminiTokens: 0 },
      suggestions: [],
      userNotes: [],
      shots: [],
      gates: {},
      phaseStart: {},
      discovery: null,
      planCritique: null,
      report: null,
      error: null,
    };
    settings.save({ lastProjectDir: projectDir, defaultAgent: agentId });
    this.created();
    this.guarded(() => this.plan());
    return this.job.id;
  }

  replan(feedback) {
    if (this.running || !this.job || this.job.phase !== 'awaiting_approval') throw new Error('Yeniden planlanacak iş yok.');
    this.update({ phase: 'planning' });
    this.guarded(() => (this.job.kind ? this.planMaintenance(feedback) : this.plan(feedback)));
  }

  // Kullanıcı keşif sorularını cevapladı (ya da varsayılanları seçti): planlamaya devam.
  answerQuestions(answers) {
    const job = this.job;
    if (this.running || !job?.discovery || job.phase !== 'awaiting_answers') throw new Error('Cevap bekleyen soru yok.');
    const qs = job.discovery.questions || [];
    job.discovery.answers = qs.map((q, i) => {
      const a = answers?.[i];
      return { question: q.question, answer: (typeof a === 'string' && a.trim()) || q.default };
    });
    this.log('system', 'info', `Cevaplar alındı: ${job.discovery.answers.map((a) => `${a.question} → ${a.answer}`).join(' | ')}`);
    this.update({ phase: 'planning' });
    this.guarded(() => this.plan());
  }

  async plan(feedback) {
    const job = this.job;
    const s = settings.get();
    this.log('gemini', 'step', feedback ? 'Plan geri bildirime göre güncelleniyor…' : job.discovery ? 'Planlama sürüyor…' : 'Gemini isteği analiz ediyor…');
    if (!job.discovery && !feedback) this.log('system', 'info', `Modeller · Gemini: ${s.geminiModel}${this.modelNote(s)}`);
    this.syncEnv();
    const existing = project.describe(job.projectDir);
    if (existing && !job.discovery) this.log('system', 'info', 'Klasörde mevcut proje bulundu; plan bunun üzerine kurulacak.');
    if (job.attachments.length && !job.discovery) this.log('system', 'info', `${job.attachments.length} doküman Gemini'ye gönderiliyor: ${job.attachments.map((a) => a.name).join(', ')}`);

    const docParts = await docs.toGeminiParts(job.attachments);
    const big = { temperature: 0.3, maxOutputTokens: 65536 };
    const attachmentNames = job.attachments.filter((a) => !docs.isDesign(a)).map((a) => a.name);
    // Tasarım dosyaları: projeye yazılır (Claude planlayıcı klasörde görür), sayfalarının görüntüsü alınır (Gemini görür).
    const designNames = job.attachments.filter(docs.isDesign).map((a) => `${a.name}${a.kind === 'folder' ? `/ (${a.files} files)` : ''}`);
    if (designNames.length && !job.discovery) {
      const design = docs.writeDesign(job.projectDir, job.attachments);
      job.designRefs = design.refs;
      job.designPages = design.pages;
      this.log('system', 'info', `${designNames.length} tasarım dosyası projeye kopyalandı (docs/sonda/design): arayüz bu tasarıma göre yapılacak.`);
      await this.designPreviews();
    }
    docParts.push(...P.designPreviewParts(job));

    // 0 — Keşif: kıdemli ürün yöneticisi gözüyle tam ürün tanımı + yalnızca kullanıcının verebileceği kararlar.
    if (!job.discovery) {
      this.log('gemini', 'info', 'Keşif · Gemini isteği kıdemli ürün yöneticisi gözüyle tam ürün tanımına genişletiyor (kullanıcılar, yolculuklar, ekranlar, iş kuralları)…');
      const d = await this.gem({ ...big, temperature: 0.5, system: P.PLANNER_BASE + P.STEP_DISCOVERY, parts: [{ text: P.planUserText({ idea: job.idea, existing, attachmentNames, designNames, env: job.env }) }, ...docParts], schema: P.DISCOVERY_SCHEMA, progressLabel: 'Ürün tanımı yazılıyor' });
      const questions = (d?.questions || []).filter((q) => q?.question).slice(0, 6).map((q) => ({
        question: q.question,
        why: q.why || '',
        options: (q.options || []).filter(Boolean).slice(0, 5),
        default: q.default || q.options?.[0] || '',
      }));
      job.discovery = { productBrief: String(d?.productBrief || '').trim(), questions, answers: null };
      this.log('gemini', 'ok', `Ürün tanımı hazır (${Math.round(job.discovery.productBrief.length / 1000)}K karakter)${questions.length ? ` · ${questions.length} soru` : ''}.`);
      if (questions.length && !s.autoApprove) {
        this.log('gemini', 'info', 'Planı netleştirmek için cevaplarınız bekleniyor (her sorunun önerilen bir varsayılanı var).');
        this.update({ phase: 'awaiting_answers' });
        return;
      }
      job.discovery.answers = questions.map((q) => ({ question: q.question, answer: q.default }));
    }

    const previousPlan = feedback && job.plan ? { ...job.plan, tasks: job.tasks.map(({ phase, title, goal, details, acceptance, tests, covers }) => ({ phase, title, goal, details, acceptance, tests, covers })) } : null;
    const base = P.planUserText({ idea: job.idea, existing, feedback, previousPlan, attachmentNames, designNames, discovery: job.discovery, env: job.env });

    // 1/4 — Gereksinimler
    this.checkAbort();
    this.log('gemini', 'info', '1/4 · Gereksinimler çıkarılıyor (her kural ayrı madde)…');
    const head = await this.gem({ ...big, system: P.PLANNER_BASE + P.STEP_REQUIREMENTS, parts: [{ text: base }, ...docParts], schema: P.REQUIREMENTS_SCHEMA, progressLabel: 'Gereksinimler yazılıyor' });
    head.stack = head.stack || [];
    head.features = head.features || [];
    head.assumptions = head.assumptions || [];
    head.threatModel = (head.threatModel || []).filter(Boolean).slice(0, 14);
    head.designDirection = String(head.designDirection || '').trim().slice(0, 8000);
    if (head.designDirection) this.log('gemini', 'info', 'Tasarım yönü belirlendi: ürüne özel tipografi, palet ve imza detaylar (arayüz buna göre kurulacak).');
    head.questions = (head.questions || []).filter(Boolean).slice(0, 3);
    head.requirements = (head.requirements || []).filter((r) => r?.id && r?.text);
    if (!head.requirements.length) throw new Error('Gemini gereksinim listesi üretemedi. Tekrar deneyin.');
    this.log('gemini', 'ok', `${head.requirements.length} gereksinim çıkarıldı.`);

    // Güncel sürümler: Gemini'nin eski API bilgisiyle (Tailwind 3, Zod 3…) şartname yazmasını önler.
    job.versions = await versions.currentVersions([job.idea, job.discovery?.productBrief, head.stack.join(', ')].join('\n'), { signal: this.signal }).catch(() => ({}));
    if (Object.keys(job.versions).length) this.log('system', 'info', `Güncel sürümler npm'den alındı: ${Object.entries(job.versions).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    const baseV = base + P.versionsBlock(job.versions);

    // Plan: varsayılan olarak Claude mühendis yazar, Gemini yönetici onaylar; olmazsa Gemini planlar.
    const cleanMd = (t) => String(t).trim().replace(/^```(?:markdown|md)?\s*/i, '').replace(/```\s*$/, '');
    const uncoveredOf = (tasks) => {
      const covered = new Set(tasks.flatMap((t) => t.covers || []));
      return head.requirements.map((r) => r.id).filter((id) => !covered.has(id));
    };
    const thinOf = (tasks) => tasks.filter((t) => (t.acceptance || []).length < 4 || (t.tests || []).length < 2).map((t) => `- ${t.title} (acceptance ${(t.acceptance || []).length}, tests ${(t.tests || []).length})`);
    let spec = null;
    let tp = null;
    job.planReview = null;
    job.planCritique = null;
    if (s.planner !== 'gemini' && this.reviewerId()) {
      this.checkAbort();
      const r = await this.claudePlan({ baseV, head, uncoveredOf, thinOf, cleanMd });
      if (r) ({ spec, tp } = r);
      else this.log('system', 'warn', 'Claude plan oturumu kullanılabilir bir plan vermedi; Gemini planlayıcıya geçiliyor.');
    }
    if (!tp) ({ spec, tp } = await this.geminiPlan({ baseV, head, docParts, s, big, cleanMd, uncoveredOf, thinOf }));
    tp.tasks = (tp.tasks || []).filter((t) => t?.title && t?.details);
    if (!tp.tasks.length) throw new Error('Plan kullanılabilir bir görev içermiyor. Tekrar deneyin.');
    const stillThin = thinOf(tp.tasks);
    if (stillThin.length) this.log('gemini', 'warn', `Uyarı: ${stillThin.length} görevde 4'ten az kabul kriteri ya da 2'den az test var.`);
    const avgCovers = tp.tasks.reduce((n, t) => n + (t.covers || []).length, 0) / tp.tasks.length;
    if (avgCovers > 8) this.log('gemini', 'warn', `Görev başına ortalama ${avgCovers.toFixed(1)} gereksinim düşüyor; görevler büyük. İstekte görev sayısını sınırladıysanız sınırı artırmak kaliteyi yükseltir.`);
    const stillUncovered = uncoveredOf(tp.tasks);
    if (stillUncovered.length) this.log('gemini', 'warn', `Uyarı: ${stillUncovered.length} gereksinim hiçbir göreve bağlanmadı (${stillUncovered.slice(0, 12).join(', ')}${stillUncovered.length > 12 ? '…' : ''}). Son incelemede kontrol edilecek.`);

    const plan = { ...head, spec, verify: { setup: [], commands: [], routes: [], devCommand: '', devUrl: '', ...(tp.verify || {}) } };
    const tasks = tp.tasks.slice(0, 60);
    const phaseCount = new Set(tasks.map((t) => t.phase).filter(Boolean)).size;
    this.log('gemini', 'ok', `Plan hazır: ${plan.projectName} · ${phaseCount > 1 ? `${phaseCount} faz · ` : ''}${tasks.length} görev · ${plan.requirements.length} gereksinim · şartname ${Math.round(spec.length / 1000)}K`);
    if (plan.questions.length) this.log('gemini', 'info', `Gemini'nin ${plan.questions.length} ek sorusu var (cevaplamak isteğe bağlı; varsayılanlar planda).`);
    this.update({
      plan,
      gates: {},
      tasks: tasks.map((t, i) => ({
        id: `t${i + 1}`,
        phase: t.phase || '',
        title: t.title,
        goal: t.goal || '',
        details: t.details,
        acceptance: t.acceptance || [],
        tests: t.tests || [],
        covers: t.covers || [],
        status: 'pending',
        attempts: 0,
      })),
      phase: 'awaiting_approval',
    });

    if (s.autoApprove) {
      this.log('system', 'info', 'Otomatik onay açık — başlatılıyor.');
      await this.pipeline();
    }
  }

  // Gemini planlar (yedek yol ya da "planner: gemini" ayarı): 6 uzman bölümlü şartname → görevler →
  // bağımsız Claude eleştirisi → Gemini son hali → şartname kararlarla yeniden yazılır.
  async geminiPlan({ baseV, head, docParts, s, big, cleanMd, uncoveredOf, thinOf }) {
    const job = this.job;
    // 2/4 — Derin teknik şartname: 6 uzman bölüm (önce mimari ve veri modeli, sonra diğerleri paralel).
    this.checkAbort();
    this.log('gemini', 'info', `2/4 · Derin teknik şartname: ${P.SPEC_SECTIONS.length} uzman bölüm (mimari, veri modeli, API, ekranlar, akışlar, güvenlik/operasyon)…`);
    const written = {};
    const writeSection = async (sec) => {
      const done = P.SPEC_SECTIONS.filter((x) => written[x.key]).map((x) => written[x.key]);
      const text = await this.gem({ ...big, system: P.specSectionSystem(sec), parts: [{ text: P.specSectionUserText(baseV, head, done) }, ...docParts] });
      written[sec.key] = cleanMd(text);
      this.log('gemini', 'ok', `Şartname bölümü hazır: ${sec.title} (${Math.round(written[sec.key].length / 1000)}K)`);
    };
    const [first, second, ...rest] = P.SPEC_SECTIONS;
    await writeSection(first);
    this.checkAbort();
    await writeSection(second);
    this.checkAbort();
    await this.together(rest.map(writeSection));
    let spec = P.SPEC_SECTIONS.map((x) => written[x.key]).join('\n\n');
    this.log('gemini', 'ok', `Şartname hazır (${Math.round(spec.length / 1000)}K karakter).`);

    // 3/4 — Fazlar ve görevler (Given/When/Then kabul kriterleri + somut testler)
    this.checkAbort();
    this.log('gemini', 'info', '3/4 · Fazlar ve görevler planlanıyor (kabul kriterleri ve test senaryolarıyla)…');
    let tp = await this.gem({ ...big, temperature: 0.4, system: P.PLANNER_BASE + P.STEP_TASKS, parts: [{ text: P.tasksUserText(baseV, head, spec) }, ...docParts], schema: P.TASKS_SCHEMA, progressLabel: 'Görevler yazılıyor' });
    if (tp && Array.isArray(tp.tasks)) tp.tasks = tp.tasks.filter((t) => t && typeof t === 'object');
    if (!tp?.tasks?.length) throw new Error('Gemini geçerli bir görev listesi üretemedi. Tekrar deneyin.');

    // Bağımsız eleştiri: Claude klasörü ve güncel kütüphane sürümlerini salt-okunur inceleyip planı eleştirir.
    let critique = null;
    if (s.reviewLevel !== 'standard' && this.reviewerId()) {
      this.checkAbort();
      const label = agents.ADAPTERS[this.reviewerId()].label;
      this.log('review', 'step', `${label} planı bağımsız olarak eleştiriyor (salt-okunur: mevcut kod, güncel sürümler, görev sırası, test edilebilirlik)…`);
      try {
        const res = await this.runAgent(P.planCritiquePrompt({ lang: this.userLang(head), base: baseV, head, spec, draft: tp }), {
          mode: 'review',
          schema: P.PLAN_CRITIQUE_SCHEMA,
          agentId: this.reviewerId(),
          label: 'plan eleştirisi',
          src: 'review',
          timeoutMin: 30,
        });
        critique = await this.structuredFrom(res, P.PLAN_CRITIQUE_SCHEMA, 'Plan eleştirisi');
        if (critique) {
          const n = (sev) => (critique.findings || []).filter((f) => f.severity === sev).length;
          this.log('review', critique.verdict === 'solid' ? 'ok' : 'warn', `Plan eleştirisi: ${critique.verdict === 'solid' ? 'sağlam' : 'değişiklik gerekli'} — ${n('high')} yüksek, ${n('medium')} orta, ${n('low')} düşük bulgu. ${critique.summary}`);
          for (const f of (critique.findings || []).filter((x) => x.severity !== 'low').slice(0, 10)) this.log('review', f.severity === 'high' ? 'warn' : 'dim', `[${f.severity}/${f.area}] ${f.problem}`);
          job.planCritique = critique;
        } else {
          this.log('review', 'warn', `Plan eleştirisi alınamadı${res.error ? `: ${String(res.error).slice(0, 200)}` : ''}; Gemini denetimiyle devam ediliyor.`);
        }
      } catch (e) {
        this.checkAbort();
        this.log('review', 'warn', `Plan eleştirisi yapılamadı: ${e.message}. Gemini denetimiyle devam ediliyor.`);
      }
    }

    // 4/4 — Gemini son hali: kapsanmayan gereksinimler, test tabanının altındaki görevler ve Claude'un eleştirisi.
    const uncovered = uncoveredOf(tp.tasks);
    const thin = thinOf(tp.tasks);
    if (s.planSelfReview || uncovered.length || critique || thin.length) {
      this.checkAbort();
      this.log('gemini', 'info', `4/4 · Gemini planı son haline getiriyor${critique ? ' (eleştirideki bulgular işleniyor)' : ''}${uncovered.length ? ` · ${uncovered.length} kapsanmayan gereksinim` : ''}${thin.length ? ` · ${thin.length} görevde test/kabul kriteri eksik` : ''}…`);
      try {
        const reviewed = await this.gem({ ...big, system: P.PLANNER_BASE + P.STEP_TASKS_REVIEW, parts: [{ text: P.tasksReviewUserText(baseV, head, spec, tp, uncovered, critique, thin) }], schema: P.TASKS_SCHEMA, progressLabel: 'Plan yeniden yazılıyor' });
        if (reviewed && Array.isArray(reviewed.tasks)) reviewed.tasks = reviewed.tasks.filter((t) => t && typeof t === 'object');
        if (reviewed?.tasks?.length) tp = reviewed;
      } catch (e) {
        this.checkAbort();
        this.log('gemini', 'warn', `Plan denetimi yapılamadı, taslak kullanılıyor: ${e.message}`);
      }
    }

    // Kararlar şartnamenin sonuna "ek" olarak değil, ilgili bölümlerin içine işlenir: çelişki kalmaz.
    const decisions = tp.specAddendum?.trim() || '';
    if (decisions || (critique?.findings || []).some((f) => f.severity !== 'low')) {
      this.checkAbort();
      this.log('gemini', 'info', 'Şartname, plan incelemesindeki kararlarla bölüm bölüm yeniden yazılıyor (çelişki kalmaması için)…');
      let fellBack = false;
      const rewritten = await Promise.all(
        P.SPEC_SECTIONS.map(async (sec) => {
          try {
            const t = cleanMd(await this.gem({ ...big, system: P.specRewriteSystem(sec), parts: [{ text: P.specRewriteUserText({ base: baseV, head, sectionText: written[sec.key], critique, decisions }) }] }));
            if (t.length >= 0.6 * written[sec.key].length) return t;
          } catch (e) {
            this.checkAbort();
          }
          fellBack = true;
          return written[sec.key];
        })
      );
      spec = rewritten.join('\n\n');
      if (fellBack && decisions) spec += `\n\n## Addendum — plan review decisions\n${cleanMd(decisions)}`;
      this.log('gemini', 'ok', `Şartname kararlarla güncellendi (${Math.round(spec.length / 1000)}K karakter)${fellBack ? '; bazı bölümler için kararlar ek olarak eklendi' : ''}.`);
    }
    return { spec, tp };
  }

  // Claude mühendis planlar (salt-okunur, araçlarla), Gemini yönetici değerlendirir; gerekirse Claude
  // aynı oturumda revize eder. Kullanılabilir plan çıkmazsa null döner (Gemini yoluna geçilir).
  async claudePlan({ baseV, head, uncoveredOf, thinOf, cleanMd }) {
    const job = this.job;
    const rid = this.reviewerId();
    const label = agents.ADAPTERS[rid].label;
    const valid = (pl) => pl && typeof pl.spec === 'string' && pl.spec.trim().length > 500 && Array.isArray(pl.tasks) && pl.tasks.some((t) => t?.title && t?.details);
    this.log('review', 'step', `2/4 · ${label} mühendis olarak teknik şartnameyi ve görev planını yazıyor (klasörü inceliyor, güncel sürümleri ve komutları doğruluyor)…`);
    let res;
    try {
      res = await this.runAgent(P.claudePlanPrompt({ base: baseV, head, job }), { mode: 'review', schema: P.CLAUDE_PLAN_SCHEMA, agentId: rid, label: 'plan yazımı', src: 'review', timeoutMin: 40 });
    } catch (e) {
      this.checkAbort();
      // Oturum (giriş), kullanım limiti ya da bağlantı sorunu: Gemini planlayıcıya geçmek çözüm değildir (planı
      // mühendis yazar, kodlama da aynı ajanla yapılacak). İş bu hatayla durur; sorun giderilince "Sürdür" ile
      // planlama kaldığı yerden devam eder.
      if (agents.failureKind(e.message) !== 'error') throw e;
      this.log('review', 'warn', `Plan oturumu başarısız: ${e.message}`);
      return null;
    }
    const tidy = (pl) => (pl && Array.isArray(pl.tasks) ? { ...pl, tasks: pl.tasks.filter((t) => t && typeof t === 'object') } : pl);
    let plan = tidy(await this.structuredFrom(res, P.CLAUDE_PLAN_SCHEMA, 'Plan'));
    if (!valid(plan)) return null;
    let sessionId = res.sessionId;
    this.log('review', 'ok', `Plan yazıldı: ${plan.tasks.length} görev · şartname ${Math.round(plan.spec.length / 1000)}K${plan.decisions ? ` · kararlar: ${String(plan.decisions).split('\n')[0].slice(0, 160)}` : ''}`);

    const rounds = [];
    const maxRounds = 2;
    for (let round = 0; ; round++) {
      this.checkAbort();
      const uncovered = uncoveredOf(plan.tasks);
      const thin = thinOf(plan.tasks);
      this.log('gemini', 'info', `3/4 · Gemini yönetici olarak planı isteğe, ürün tanımına ve gereksinimlere göre değerlendiriyor${uncovered.length ? ` · ${uncovered.length} kapsanmayan gereksinim` : ''}${thin.length ? ` · ${thin.length} görevde test/kabul kriteri eksik` : ''}…`);
      let review;
      try {
        review = await this.gem({ system: P.managerReviewSystem(this.userLang(head)), parts: [{ text: P.managerReviewUserText({ base: baseV, head, plan, uncovered, thin }) }], schema: P.MANAGER_REVIEW_SCHEMA, temperature: 0.2, maxOutputTokens: 32768 });
      } catch (e) {
        this.checkAbort();
        this.log('gemini', 'warn', `Yönetici değerlendirmesi yapılamadı (${e.message}); plan olduğu gibi kullanılıyor.`);
        break;
      }
      const blocking = (review.findings || []).filter((f) => f.severity !== 'low');
      const needsRevision = review.verdict === 'revise' || uncovered.length || thin.length;
      rounds.push({ verdict: needsRevision ? 'revise' : 'approve', summary: review.summary, findings: review.findings || [] });
      this.log('gemini', needsRevision ? 'warn' : 'ok', `Yönetici: ${needsRevision ? 'DEĞİŞİKLİK İSTİYOR' : 'ONAYLADI'} — ${review.summary}`);
      for (const f of blocking.slice(0, 10)) this.log('gemini', f.severity === 'high' ? 'warn' : 'dim', `[${f.severity}${f.area ? `/${f.area}` : ''}] ${f.problem}`);
      if (!needsRevision || round >= maxRounds) break;

      this.log('review', 'step', `${label} yöneticinin istediği değişiklikleri uyguluyor (tur ${round + 1}/${maxRounds})…`);
      try {
        const rev = await this.runAgent(P.planRevisionPrompt(review, uncovered, thin), { mode: 'review', schema: P.CLAUDE_PLAN_SCHEMA, agentId: rid, resumeId: sessionId, label: `plan revizyonu ${round + 1}`, src: 'review', timeoutMin: 30 });
        const revised = tidy(await this.structuredFrom(rev, P.CLAUDE_PLAN_SCHEMA, 'Plan revizyonu'));
        if (valid(revised)) {
          plan = revised;
          sessionId = rev.sessionId || sessionId;
          this.log('review', 'ok', `Plan revize edildi: ${plan.tasks.length} görev · şartname ${Math.round(plan.spec.length / 1000)}K`);
        } else {
          this.log('review', 'warn', 'Revizyon kullanılabilir bir plan döndürmedi; önceki plan korunuyor.');
          break;
        }
      } catch (e) {
        this.checkAbort();
        this.log('review', 'warn', `Revizyon yapılamadı: ${e.message}`);
        break;
      }
    }
    job.planReview = { planner: label, rounds };
    if (plan.stack?.length) head.stack = plan.stack;
    return {
      spec: cleanMd(plan.spec),
      tp: { tasks: plan.tasks, verify: plan.verify || {} },
    };
  }

  approve({ skipTaskIds = [] } = {}) {
    if (this.running || !this.job?.plan || this.job.phase !== 'awaiting_approval') throw new Error('Onaylanacak plan yok.');
    const skip = new Set(Array.isArray(skipTaskIds) ? skipTaskIds : []);
    for (const t of this.job.tasks) if (skip.has(t.id) && t.status === 'pending') t.status = 'skipped';
    this.guarded(() => this.pipeline());
  }

  // İptal geri alınır: iş, iptal edildiği bekleme durumuna döner (plan hazırsa onaya, sorular cevaplanmadıysa
  // sorulara). Ürün tanımı, şartname ve görev planı durduğu için hiçbir şey yeniden üretilmez.
  reopen() {
    const job = this.job;
    if (this.running || job?.phase !== 'cancelled') throw new Error('Geri alınacak bir iptal yok.');
    const d = job.discovery;
    const phase = job.plan && job.tasks?.length ? 'awaiting_approval' : d?.questions?.length && !d.answers ? 'awaiting_answers' : null;
    if (!phase) throw new Error('Bu işte geri getirilecek bir plan yok; yeni bir plan başlatın.');
    this.log('system', 'info', phase === 'awaiting_approval' ? 'İptal geri alındı: plan onayınızı bekliyor.' : 'İptal geri alındı: sorular cevabınızı bekliyor.');
    this.update({ phase });
  }

  specMarkdown() {
    const p = this.job.plan;
    return `# ${p.projectName}

${p.summary}

**Stack:** ${p.stack.join(', ')}
**UI language:** ${p.language || '-'}

## Requirements
${p.requirements.map((r) => `- **${r.id}**: ${r.text}`).join('\n')}

## Assumptions
${p.assumptions.map((a) => `- ${a}`).join('\n') || '-'}
${String(p.designDirection || '').trim() ? `\n## Design direction (binding for every screen)\n${p.designDirection.trim()}\n` : ''}
${p.spec}
`;
  }

  // Tasarım sayfalarının görüntüsü: Gemini incelemede görür, ajanlar Read aracıyla bakar (docs/sonda/design/_onizleme).
  async designPreviews() {
    const job = this.job;
    const dir = job.projectDir;
    const pages = (job.designPages || []).slice(0, 4);
    job.designPreviews = [];
    if (!pages.length) return;
    const out = docs.previewDir(dir);
    fs.mkdirSync(out, { recursive: true });
    for (const page of pages) {
      const slug = page.replace(/^docs\/sonda\/design\//, '').replace(/\.html?$/i, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'sayfa';
      for (const [suffix, opts] of [['masaustu', { width: 1280, height: 900 }], ['mobil', { width: 390, height: 844, mobile: true }]]) {
        try {
          const r = await verify.captureFile(path.join(dir, page), opts);
          if (!r.jpeg) continue;
          const file = path.join(out, `${slug}-${suffix}.jpg`);
          fs.writeFileSync(file, r.jpeg);
          job.designPreviews.push(`${docs.previewDir('').replace(/^[\\/]+/, '').split(path.sep).join('/')}/${slug}-${suffix}.jpg`);
        } catch (e) {
          this.log('system', 'warn', `Tasarım önizlemesi alınamadı (${page}): ${e.message}`);
        }
      }
    }
    if (job.designPreviews.length) this.log('system', 'info', `Tasarım önizlemesi alındı: ${pages.length} sayfa (masaüstü + mobil) → docs/sonda/design/_onizleme`);
    this.update();
  }
}

module.exports = Planning;
