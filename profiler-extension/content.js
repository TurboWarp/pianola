// Relays messages between the worker page and the extension's service worker. Pages on arbitrary
// addresses (LAN, Tailscale) cannot message an extension directly, but content scripts can.

window.addEventListener('message', event => {
    if (event.source !== window || !event.data || event.data.source !== 'benchmark-tracer-page') return;
    const {id, request} = event.data;
    chrome.runtime.sendMessage(request, response => {
        const error = chrome.runtime.lastError;
        window.postMessage({
            source: 'benchmark-tracer-extension',
            id,
            response: error ? {ok: false, error: error.message} : response
        }, '*');
    });
});
