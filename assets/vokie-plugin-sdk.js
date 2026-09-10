(function () {
  const pending = new Map();

  function request(action, payload) {
    const requestId = `vokie-ui-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    window.parent.postMessage(
      {
        type: 'vokie_plugin_request',
        requestId,
        action,
        ...(payload || {})
      },
      '*'
    );
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        pending.delete(requestId);
        reject(new Error('Host 请求超时'));
      }, 8000);
      pending.set(requestId, {
        resolve: (value) => {
          window.clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          window.clearTimeout(timer);
          reject(error);
        }
      });
    });
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || message.type !== 'vokie_plugin_response') return;
    const task = pending.get(message.requestId);
    if (!task) return;
    pending.delete(message.requestId);
    if (message.error) task.reject(new Error(message.error));
    else task.resolve(message);
  });

  window.vokiePlugin = {
    getState: () => request('get_state'),
    getAudioInputs: (query) => request('query_audio_inputs', { query }),
    configure: (config) => request('configure', { config })
  };
})();
