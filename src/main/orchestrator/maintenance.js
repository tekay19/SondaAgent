// Bakım işleri: bitmiş projede özellik ekleme, hata düzeltme, refactor — salt okunur analiz ve plan.
// (Orchestrator sınıfının yöntemleri; bkz. index.js — `this` orkestratördür.)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const settings = require('../settings');
const agents = require('../agents');
const project = require('../project');
const docs = require('../docs');
const jobs = require('../jobs');
const P = require('../prompts');
const { cleanText, guessLang } = require('./shared');

class Maintenance {
  // ---------- bakım: bitmiş / mevcut projede hata düzeltme ve refactor ----------
  // `stack`: bu işin kadrosu (bkz. planning.startPlanning); verilmezse projenin işinden devralınır ya da Ayarlar'dan.
  startMaintenance({ kind, text, bugs, items, projectDir, agent, stack, attachments }) {
    if (this.running) throw new Error('Şu anda çalışan bir iş var. Önce durdurun.');
    if (!['bugfix', 'refactor', 'feature'].includes(kind)) throw new Error('Geçersiz iş türü.');
    if (!projectDir || !fs.existsSync(projectDir) || project.isEmptyDir(projectDir)) throw new Error('Bu klasörde üzerinde çalışılacak bir proje yok.');
    const s = settings.withStack(settings.get(), { ...settings.cleanStack(stack), ...(agents.ADAPTERS[agent] ? { agent } : {}) });
    if (!settings.managerReady(s)) throw new Error(settings.managerMissingMessage(s));
    const agentId = s.defaultAgent;
    if (!agents.resolveBin(agentId, s)) throw new Error(`${agents.ADAPTERS[agentId].label} bulunamadı. Kurulum: ${agents.ADAPTERS[agentId].install}`);
    const list = (items || bugs || []).map((b) => String(b || '').trim()).filter(Boolean);
    const free = String(text || '').trim();
    const request = kind === 'refactor' ? free : list.length > 1 ? list.map((b, i) => `${i + 1}) ${b}`).join('\n\n') : list[0] || free;
    if (kind === 'bugfix' && !request) throw new Error('Hatayı tarif edin: ne yaptınız, ne oldu, ne olmalıydı?');
    if (kind === 'feature' && !request) throw new Error('Eklenecek özelliği tarif edin.');

    this.job = {
      id: `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
      kind,
      request,
      idea: request || 'Kod sağlığı taraması ve refactor',
      projectDir,
      agent: agentId,
      stack: settings.resolveStack(s),
      attachments: docs.sanitizeAttachments(attachments),
      createdAt: Date.now(),
      phase: 'planning',
      plan: null,
      tasks: [],
      stats: { agentRuns: 0, costUsd: 0, managerTokens: 0 },
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
    settings.save({ lastProjectDir: projectDir });
    settings.rememberProjectStack(projectDir, this.job.stack);
    this.created();
    this.guarded(() => this.planMaintenance());
    return this.job.id;
  }

  // Teşhis / kod sağlığı taraması: Claude projeyi salt okunur inceler, bulguları ve görev planını çıkarır.
  // Önceki Sonda planı varsa gereksinimleri ve şartnamesi devralınır (kabul edilmiş davranış korunur).
  async planMaintenance(feedback) {
    const job = this.job;
    const s = this.cfg();
    const dir = job.projectDir;
    const bug = job.kind === 'bugfix';
    const feat = job.kind === 'feature';
    const what = feat ? 'Özellik tasarımı' : bug ? 'Teşhis' : 'Kod sağlığı taraması';
    this.syncEnv();
    const rid = this.reviewerId();
    if (!rid) throw new Error('İnceleme için Claude Code ya da seçili ajan bulunamadı.');

    const base = jobs.latestWithPlan(dir, job.id);
    const basePlan = base?.plan ? { ...base.plan, maintenance: undefined } : null;
    this.log('system', 'step', feat
      ? `Özellik tasarlanıyor: ${agents.ADAPTERS[rid].label} projenin yapısını ve kurallarını inceleyip özelliği buna uyduruyor (salt okunur)…`
      : bug
        ? `Hata inceleniyor: ${agents.ADAPTERS[rid].label} kök nedeni arıyor (salt okunur)…`
        : `Kod sağlığı taraması: ${agents.ADAPTERS[rid].label} refactor adaylarını ve hataları çıkarıyor (salt okunur)…`);
    if (!feedback) this.log('system', 'info', `Modeller · ${this.managerNote(s)}${this.modelNote(s)}`);
    if (basePlan) this.log('system', 'info', `Önceki Sonda planı devralındı: ${basePlan.projectName} · ${(basePlan.requirements || []).length} gereksinim korunacak.`);
    else this.log('system', 'info', 'Bu klasör için Sonda planı yok; proje önce incelenip tanınacak.');

    // Kanıt dosyaları (ekran görüntüsü, log) ajanın okuyabilmesi için projeye kopyalanır.
    let refs = [];
    if (job.attachments.length) {
      const written = docs.writeToProject(dir, job.attachments, null);
      job.designRefs = written.designRefs;
      job.designPages = written.designPages;
      if (job.designPages?.length) await this.designPreviews();
      refs = [...written.refs, ...written.designRefs.slice(0, 40), ...(job.designPreviews || [])];
    }
    // Geri bildirimle yeniden planlama: önceki tasarımın tamamı (yeni gereksinimler, şartname eki, kapsam eşlemesi)
    // verilir; aksi halde model bunları sessizce düşürür ve görevler gereksinimsiz kalır.
    const pm = job.plan?.maintenance;
    const previous = feedback && pm
      ? {
          summary: pm.summary,
          findings: pm.findings,
          requirements: pm.newRequirements || [],
          specAddendum: pm.specAddendum || '',
          assumptions: pm.assumptions || [],
          threats: pm.threats || [],
          tasks: job.tasks.map(({ kind, title, goal, details, acceptance, tests, covers }) => ({ type: kind, title, goal, details, acceptance, tests, covers })),
        }
      : null;
    const res = await this.runAgent(
      P.maintenancePlanPrompt({ kind: job.kind, text: job.request, plan: basePlan, existing: basePlan ? null : project.describe(dir), feedback, previous, lang: guessLang(`${job.request} ${feedback || ''}`) || basePlan?.userLanguage || basePlan?.language, refs }),
      { mode: 'review', schema: P.MAINTENANCE_SCHEMA, agentId: rid, label: what.toLocaleLowerCase('tr-TR'), src: 'review', timeoutMin: 30 }
    );
    const out = await this.structuredFrom(res, P.MAINTENANCE_SCHEMA, what);
    if (!out || !Array.isArray(out.tasks)) throw new Error(`${what} sonuç vermedi${res.error ? `: ${String(res.error).slice(0, 300)}` : '. Tekrar deneyin.'}`);

    const proj = out.project || {};
    const plan = basePlan
      ? { ...basePlan, questions: [] }
      : { projectName: proj.name || path.basename(dir).toLowerCase().replace(/[^a-z0-9]+/g, '-'), summary: proj.summary || out.summary, language: proj.language || 'Turkish', stack: proj.stack || [], features: [], assumptions: [], threatModel: [], requirements: [], questions: [], spec: proj.overview || '' };
    plan.stack = plan.stack || [];
    plan.features = plan.features || [];
    plan.assumptions = plan.assumptions || [];
    plan.requirements = plan.requirements || [];
    plan.verify = { setup: [], commands: [], routes: [], devCommand: '', devUrl: '', ...(plan.verify || {}) };
    plan.verify.routes = [...new Set([...(out.routes || []), ...(plan.verify.routes || [])])].slice(0, 6);
    out.summary = cleanText(out.summary);
    const findings = (out.findings || []).filter((f) => f?.title).slice(0, 30).map((f) => ({ ...f, title: cleanText(f.title), detail: cleanText(f.detail), files: (f.files || []).filter(Boolean) }));
    for (const t of out.tasks) if (t) Object.assign(t, { title: cleanText(t.title), goal: cleanText(t.goal), details: cleanText(t.details) });
    plan.maintenance = { kind: job.kind, request: job.request, summary: out.summary || '', findings, refs };

    // Özellik ekleme: yeni gereksinimler, şartname eki, varsayımlar ve tehditler plana işlenir.
    const idMap = {};
    if (feat) {
      const taken = new Set(plan.requirements.map((r) => r.id));
      let n = Math.max(0, ...plan.requirements.map((r) => Number(String(r.id).replace(/\D/g, '')) || 0));
      const added = (out.requirements || []).filter((r) => r?.text).slice(0, 60).map((r) => {
        const asked = String(r.id || '').trim();
        let id = asked;
        if (!/^R\d+$/.test(id) || taken.has(id)) id = `R${(n += 1)}`;
        else n = Math.max(n, Number(id.slice(1)));
        taken.add(id);
        if (asked) idMap[asked] = id;
        return { id, text: cleanText(r.text) };
      });
      plan.requirements = [...plan.requirements, ...added];
      plan.assumptions = [...plan.assumptions, ...(out.assumptions || []).filter(Boolean).map(cleanText)];
      plan.threatModel = [...(plan.threatModel || []), ...(out.threats || []).filter(Boolean).map(cleanText)].slice(0, 30);
      plan.features = [...plan.features, cleanText(job.request).split('\n')[0].slice(0, 140)];
      const addendum = cleanText(out.specAddendum).replace(/^```(?:markdown|md)?\n?/, '').replace(/\n?```$/, '');
      if (addendum) plan.spec = `${plan.spec || ''}\n\n---\n\n## Added feature (${new Date().toISOString().slice(0, 10)}): ${cleanText(job.request).split('\n')[0].slice(0, 100)}\n\n${addendum}`.trim();
      plan.maintenance.newRequirements = added;
      plan.maintenance.assumptions = (out.assumptions || []).filter(Boolean).map(cleanText);
      plan.maintenance.threats = (out.threats || []).filter(Boolean).map(cleanText);
      plan.maintenance.specAddendum = addendum;
    }

    const phaseName = feat ? 'Özellik ekleme' : bug ? 'Hata düzeltme' : 'Refactor';
    const tasks = out.tasks.filter((t) => t?.title && t?.details).slice(0, 12);
    const valid = new Set(plan.requirements.map((r) => r.id));
    const bugs = findings.filter((f) => f.type === 'bug').length;
    const FLABEL = { bug: 'hata', refactor: 'refactor', design: 'tasarım' };
    this.log('review', tasks.length ? 'ok' : 'warn', `${what} hazır: ${findings.length} ${feat ? 'tasarım kararı' : 'bulgu'}${!bug && !feat && bugs ? ` (${bugs} hata)` : ''}${feat ? ` · ${(plan.maintenance.newRequirements || []).length} yeni gereksinim` : ''} · ${tasks.length} görev — ${(out.summary || '').split('\n')[0].slice(0, 240)}`);
    for (const f of findings.slice(0, 10)) this.log('review', !feat && ['critical', 'high'].includes(f.severity) ? 'warn' : 'dim', `[${f.severity}] ${FLABEL[f.type] || f.type}: ${f.title}${(f.files || []).length ? ` (${f.files.slice(0, 3).join(', ')})` : ''}`);

    const patch = {
      plan,
      gates: {},
      reqStatus: job.reqStatus || { ...(base?.reqStatus || {}) },
      reqEvidence: job.reqEvidence || { ...(base?.reqEvidence || {}) },
      tasks: tasks.map((t, i) => ({
        id: `t${i + 1}`,
        phase: phaseName,
        kind: ['bug', 'refactor', 'feature'].includes(t.type) ? t.type : feat ? 'feature' : bug ? 'bug' : 'refactor',
        title: t.title,
        goal: t.goal || '',
        details: t.details,
        acceptance: t.acceptance || [],
        tests: t.tests || [],
        covers: feat ? [...new Set((t.covers || []).map((c) => idMap[String(c).trim()] || String(c).trim()).filter((c) => valid.has(c)))] : [],
        status: 'pending',
        attempts: 0,
      })),
    };
    // Yapılacak bir şey bulunmadıysa iş burada biter: analiz rapor olarak kalır.
    if (!tasks.length) {
      const report = `## ${what}\n\n${out.summary || ''}\n\n${findings.map((f) => `- **${f.title}** — ${f.detail}`).join('\n')}\n\nKodda değişiklik yapılmadı.`;
      this.update({ ...patch, report, phase: 'done', finishedAt: Date.now() });
      this.log('system', 'info', feat ? 'Özellik için görev planı çıkarılamadı; ayrıntılar raporda.' : bug ? 'Düzeltilecek bir kusur bulunamadı; ayrıntılar raporda.' : 'Değişiklik gerektiren bir şey bulunmadı; ayrıntılar raporda.');
      return;
    }
    this.update({ ...patch, phase: 'awaiting_approval', approvedAt: null });
    if (s.autoApprove) {
      this.log('system', 'info', 'Otomatik onay açık — başlatılıyor.');
      this.update({ approvedAt: Date.now() });
      await this.pipeline();
    }
  }
}

module.exports = Maintenance;
