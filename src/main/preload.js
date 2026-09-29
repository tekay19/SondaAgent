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
  detectAgents: (opts) => call('agents:detect', opts),
  pickFolder: () => call('dialog:folder'),
  pickDocs: () => call('dialog:docs'),
  inspectDocs: (paths) => call('docs:inspect', paths),
  pathForFile: (file) => webUtils.getPathForFile(file),
  openPath: (p) => call('shell:open', p),
  openExternal: (url) => call('shell:external', url),
  openEditor: (dir) => call('shell:editor', dir),
  testAgent: (id) => call('agents:test', id),
  loginAgent: (id) => call('agents:login', id),
  updateAgent: (id) => call('agents:update', id),
  runApp: (dir) => call('app:run', dir),
  stopApp: () => call('app:stop'),
  appStatus: () => call('app:status'),
  addNote: (text) => call('job:note', text),
  getEnv: (dir) => call('env:get', dir),
  saveEnv: (args) => call('env:save', args),
  plan: (args) => call('job:plan', args),
  replan: (feedback) => call('job:replan', { feedback }),
  answer: (answers) => call('job:answer', answers),
  approve: (args) => call('job:approve', args),
  resume: () => call('job:resume'),
  continueFinal: () => call('job:continueFinal'),
  stop: () => call('job:stop'),
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
