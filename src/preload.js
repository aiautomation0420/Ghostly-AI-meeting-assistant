const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel) => (cb) => ipcRenderer.on(channel, (_e, data) => cb(data));

contextBridge.exposeInMainWorld('ghost', {
  ask: (payload) => ipcRenderer.invoke('ask', payload),
  setStealth: (on) => ipcRenderer.send('set-stealth', on),
  setClickThrough: (on) => ipcRenderer.send('set-click-through', on),
  reset: () => ipcRenderer.send('reset'),
  hide: () => ipcRenderer.send('hide'),
  onState: on('state'),
  onStatus: on('status'),
  onStart: on('answer:start'),
  onDelta: on('answer:delta'),
  onDone: on('answer:done'),
  onError: on('answer:error'),
  onTiming: on('answer:timing'),
  onDeepStart: on('deep:start'),
  onDeepDelta: on('deep:delta'),
  onDeepError: on('deep:error'),

  // Settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (values) => ipcRenderer.invoke('settings:save', values),
  listKnowledge: () => ipcRenderer.invoke('knowledge:list'),
  addKnowledge: (paths) => ipcRenderer.invoke('knowledge:add', paths),
  pathForFile: (file) => webUtils.getPathForFile(file), // dropped File → its path on disk
  removeKnowledge: (id) => ipcRenderer.invoke('knowledge:remove', id),

  // Live audio
  toggleListen: () => ipcRenderer.send('listen:toggle'),
  suggest: () => ipcRenderer.send('suggest'),
  sendSegment: (segment) => ipcRenderer.send('audio:segment', segment),
  listenStarted: (sources) => ipcRenderer.send('listen:started', sources),
  listenFailed: (message) => ipcRenderer.send('listen:failed', message),
  audioStats: (stats) => ipcRenderer.send('audio:stats', stats),
  onListenStart: on('listen:start'),
  onPcm: on('audio:pcm'),
  onListenStop: on('listen:stop'),
  onListenState: on('listen:state'),
  onTranscript: on('transcript'),
  onSuggestStart: on('suggest:start'),
  onSuggestDelta: on('suggest:delta'),
  onSuggestTiming: on('suggest:timing'),
  onReset: on('reset'),
});
