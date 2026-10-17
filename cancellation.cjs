// Cancel the caller's wait while retaining handlers on shared/queued work.
function waitFor(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', stop);
    const stop = () => { cleanup(); reject(signal.reason || new Error('已取消')); };
    Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
  });
}
module.exports = { waitFor };
