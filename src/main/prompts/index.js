// Yönetici (planlayıcı / denetçi) ve kodlama ajanları için istemler.
// Ajan istemleri İngilizcedir (ajanlar en tutarlı bu şekilde çalışıyor);
// kullanıcıya görünen alanlar kullanıcının dilinde üretilir.
// İstemler konularına göre aynı klasördeki modüllerdedir; bu dosya eski tek-dosya arayüzünü (dışa aktarılan adları) korur:
//   base.js — Ortak kurallar ve yardımcılar: mühendislik standartları, güvenilmeyen içerik kuralı, tasarım ve sağlamlık ölçüleri.
//   context.js — Ajanlara ve inceleyicilere verilen proje bağlamı: .env, tasarım, hafıza, gereksinimler, dersler, açık bulgular.
//   planning.js — Planlama: keşif, gereksinimler, şartname bölümleri, görev planı, Claude planı, yönetici değerlendirmesi, plan eleştirisi.
//   task.js — Görev istemleri: kodlama, düzeltme, teknik brif, TDD testleri ve proje hafızası.
//   review.js — İnceleme istemleri: ilk inceleme (yönetici ya da ajan), derin inceleme, faz kapısı, son kabul, güvenlik denetimi.
//   specialists.js — Uzman denetim paneli: uzman tanımları, görev sonu incelemesi, bulgu doğrulama ve yeniden doğrulama.
//   maintenance.js — Bakım işleri (özellik ekleme, hata düzeltme, refactor): salt okunur analiz ve plan istemi.
//   report.js — Teslim raporu: rapor istemi, bulgu defteri ve uzman paneli özetleri.
const base = require('./base');
const context = require('./context');
const planning = require('./planning');
const task = require('./task');
const review = require('./review');
const specialists = require('./specialists');
const maintenance = require('./maintenance');
const report = require('./report');
const audit = require('./audit');

module.exports = {
  AUDIT_SCHEMA: audit.AUDIT_SCHEMA,
  auditPrompt: audit.auditPrompt,
  auditFixPrompt: audit.auditFixPrompt,
  auditRepairPrompt: audit.auditRepairPrompt,
  DEFAULT_STANDARDS: base.DEFAULT_STANDARDS,
  envBlock: context.envBlock,
  envReviewText: context.envReviewText,
  DESIGN_CRAFT: base.DESIGN_CRAFT,
  designBlock: context.designBlock,
  designReviewText: context.designReviewText,
  designFilesText: context.designFilesText,
  designPreviewParts: context.designPreviewParts,
  SPECIALISTS: specialists.SPECIALISTS,
  SPECIALIST_SCHEMA: specialists.SPECIALIST_SCHEMA,
  specialistPrompt: specialists.specialistPrompt,
  taskSpecialistPrompt: specialists.taskSpecialistPrompt,
  taskBudgetMin: task.taskBudgetMin,
  MAINTENANCE_SCHEMA: maintenance.MAINTENANCE_SCHEMA,
  MAINTENANCE_LABEL: base.MAINTENANCE_LABEL,
  MAINTENANCE_TITLE: base.MAINTENANCE_TITLE,
  maintenancePlanPrompt: maintenance.maintenancePlanPrompt,
  maintenanceBlock: context.maintenanceBlock,
  maintenanceReviewText: context.maintenanceReviewText,
  PANEL_VERIFY_SCHEMA: specialists.PANEL_VERIFY_SCHEMA,
  panelVerifyPrompt: specialists.panelVerifyPrompt,
  FINDING_RECHECK_SCHEMA: specialists.FINDING_RECHECK_SCHEMA,
  findingRecheckPrompt: specialists.findingRecheckPrompt,
  AGENT_REVIEW_SCHEMA: review.AGENT_REVIEW_SCHEMA,
  taskReviewPrompt: review.taskReviewPrompt,
  MEMORY_JSON_SCHEMA: task.MEMORY_JSON_SCHEMA,
  memoryAgentPrompt: task.memoryAgentPrompt,
  briefAgentPrompt: task.briefAgentPrompt,
  BRIEF_SECTIONS: task.BRIEF_SECTIONS,
  reviewMethod: review.reviewMethod,
  toJsonSchema: base.toJsonSchema,
  ROBUSTNESS_BASELINE: base.ROBUSTNESS_BASELINE,
  SCORE_KEYS: review.SCORE_KEYS,
  lessonsText: context.lessonsText,
  openFindingsText: context.openFindingsText,
  calibrationText: context.calibrationText,
  ledgerReportText: report.ledgerReportText,
  smokeProblemsText: context.smokeProblemsText,
  DISCOVERY_SCHEMA: planning.DISCOVERY_SCHEMA,
  STEP_DISCOVERY: planning.STEP_DISCOVERY,
  REQUIREMENTS_SCHEMA: planning.REQUIREMENTS_SCHEMA,
  TASKS_SCHEMA: planning.TASKS_SCHEMA,
  SPEC_SECTIONS: planning.SPEC_SECTIONS,
  specSectionSystem: planning.specSectionSystem,
  specSectionUserText: planning.specSectionUserText,
  BRIEF_SYSTEM: task.BRIEF_SYSTEM,
  briefUserText: task.briefUserText,
  SECURITY_SCHEMA: review.SECURITY_SCHEMA,
  SECURITY_SYSTEM: review.SECURITY_SYSTEM,
  reqStatusText: context.reqStatusText,
  PLANNER_BASE: planning.PLANNER_BASE,
  STEP_REQUIREMENTS: planning.STEP_REQUIREMENTS,
  STEP_TASKS: planning.STEP_TASKS,
  STEP_TASKS_REVIEW: planning.STEP_TASKS_REVIEW,
  planUserText: planning.planUserText,
  specUserText: planning.specUserText,
  tasksUserText: planning.tasksUserText,
  tasksReviewUserText: planning.tasksReviewUserText,
  taskPrompt: task.taskPrompt,
  fixPrompt: task.fixPrompt,
  finalFixPrompt: task.finalFixPrompt,
  MEMORY_SCHEMA: task.MEMORY_SCHEMA,
  MEMORY_SYSTEM: task.MEMORY_SYSTEM,
  memoryUserText: task.memoryUserText,
  PLAN_CRITIQUE_SCHEMA: planning.PLAN_CRITIQUE_SCHEMA,
  planCritiquePrompt: planning.planCritiquePrompt,
  CLAUDE_PLAN_SCHEMA: planning.CLAUDE_PLAN_SCHEMA,
  claudePlanPrompt: planning.claudePlanPrompt,
  MANAGER_REVIEW_SCHEMA: planning.MANAGER_REVIEW_SCHEMA,
  managerReviewSystem: planning.managerReviewSystem,
  managerReviewUserText: planning.managerReviewUserText,
  planRevisionPrompt: planning.planRevisionPrompt,
  specRewriteSystem: planning.specRewriteSystem,
  specRewriteUserText: planning.specRewriteUserText,
  versionsBlock: planning.versionsBlock,
  TEST_REVIEW_SCHEMA: task.TEST_REVIEW_SCHEMA,
  TEST_REVIEW_SYSTEM: task.TEST_REVIEW_SYSTEM,
  TEST_REVIEW_JSON_SCHEMA: task.TEST_REVIEW_JSON_SCHEMA,
  testReviewAgentPrompt: task.testReviewAgentPrompt,
  testReviewUserText: task.testReviewUserText,
  testFixPrompt: task.testFixPrompt,
  DEEP_REVIEW_SCHEMA: review.DEEP_REVIEW_SCHEMA,
  deepReviewPrompt: review.deepReviewPrompt,
  testAuthorPrompt: task.testAuthorPrompt,
  REVIEW_SCHEMA: review.REVIEW_SCHEMA,
  reviewSystem: review.reviewSystem,
  reviewUserText: review.reviewUserText,
  finalReviewSystem: review.finalReviewSystem,
  phaseReviewSystem: review.phaseReviewSystem,
  finalReviewParts: review.finalReviewParts,
  reportSystem: report.reportSystem,
  reportUserText: report.reportUserText,
};
