// The renderer's ONLY window into main: an allow-listed invoke().
// Shape (window.electron.invoke) matches what the ported SidecarConnection.ts expects.
const { contextBridge, ipcRenderer } = require('electron');

const INVOKE_CHANNELS = ['native-host:start', 'native-host:stop', 'native-host:status'];

contextBridge.exposeInMainWorld('electron', {
  invoke: (channel, data) => {
    if (!INVOKE_CHANNELS.includes(channel)) {
      return Promise.reject(new Error(`blocked ipc channel: ${channel}`));
    }
    return ipcRenderer.invoke(channel, data);
  },
});
