const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = async (channel, arg) => {
  const r = await ipcRenderer.invoke(channel, arg);
  if (!r.ok) throw new Error(r.error);
  return r.data;
};

contextBridge.exposeInMainWorld('sonda', {
  platform: process.platform,
  getSettings: () => call('settings:get'),
  saveSettings: (patch) => call('settings:save', patch),
  listModels: () => call('gemini:models'),
  testGemini: () => call('gemini:test'),
  // Ajan bağlantıları: algıla → kur → giriş yap → test et
  detectAgents: (opts) => call('agents:detect', opts),
  agentAuth: (id) => call('agents:auth', id),
  installAgent: (id) => call('agents:install', id),
  testAgent: (id) => call('agents:test', id),
  loginAgent: (id) => call('agents:login', id),
  logoutAgent: (id) => call('agents:logout', id),
  updateAgent: (id) => call('agents:update', id),
  pickFolder: () => call('dialog:folder'),
  pickDocs: () => call('dialog:docs'),
  pickDesign: () => call('dialog:design'),
  inspectDocs: (paths) => call('docs:inspect', paths),
  pathForFile: (file) => webUtils.getPathForFile(file),
  openExternal: (url) => call('shell:external', url),
  // Proje klasörüne dokunan eylemler işin kimliğiyle çağrılır.
  openProject: (id) => call('project:open', id),
  openEditor: (id) => call('project:editor', id),
  zipProject: (id) => call('project:zip', id),
  runApp: (id) => call('app:run', id),
  stopApp: () => call('app:stop'),
  appStatus: () => call('app:status'),
  getEnv: (dir) => call('env:get', dir),
  saveEnv: (args) => call('env:save', args),
  parseEnv: (text) => call('env:parse', text),
  plan: (args) => call('job:plan', args),
  maintain: (args) => call('job:maintain', args),
  replan: (id, feedback) => call('job:replan', { id, feedback }),
  answer: (id, answers) => call('job:answer', { id, answers }),
  approve: (id, args) => call('job:approve', { id, ...(args || {}) }),
  resume: (id) => call('job:resume', id),
  continueFinal: (id) => call('job:continueFinal', id),
  stop: (id) => call('job:stop', id),
  reopen: (id) => call('job:reopen', id),
  addNote: (id, text) => call('job:note', { id, text }),
  current: () => call('job:current'),
  listJobs: () => call('jobs:list'),
  loadJob: (id) => call('jobs:load', id),
  deleteJob: (id) => call('jobs:delete', id),
  onEvent: (cb) => {
    const fn = (_e, evt) => cb(evt);
    ipcRenderer.on('sonda:event', fn);
    return () => ipcRenderer.removeListener('sonda:event', fn);
  },
});
