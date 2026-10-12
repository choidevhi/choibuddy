// Injected into every document of the in-app browser (see browser.rs). It
// stays inert until the app calls window.__choibuddyPick(true); then it
// outlines the element under the cursor and reports the clicked one by
// navigating the top frame to choibuddy-msg://, which the app cancels and
// turns into an event. The page never gets Tauri IPC, so this is the channel.
(function () {
  'use strict';

  try {
    // WebView2 runs init scripts in iframes too; only the top frame picks.
    if (window.top !== window.self || typeof window.__choibuddyPick === 'function') return;
  } catch (error) {
    return;
  }

  var ACCENT = '#ff7a45';
  // The app ignores messages over 64 KB; leave room for the scheme and kind.
  var MAX_MESSAGE = 60000;
  var on = false;
  var host = null;
  var box = null;
  var label = null;
  var cursor = null;
  var current = null;

  function clip(text, max) {
    var value = String(text);

    if (typeof value.toWellFormed === 'function') value = value.toWellFormed();

    if (value.length <= max) return value;

    var cut = value.slice(0, max);
    var last = cut.charCodeAt(cut.length - 1);

    // Never end on half a surrogate pair: the app's JSON parser rejects it.
    return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
  }

  function encode(data) {
    return encodeURIComponent(JSON.stringify(data));
  }

  function send(kind, data) {
    try {
      window.location.href = 'choibuddy-msg://' + kind + '?d=' + encode(data);
    } catch (error) {
      // Nothing to report to; the pick simply does not arrive.
    }
  }

  function escapeIdent(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);

    return value.replace(/[^\w-]/g, '\\$&');
  }

  function uniqueId(node) {
    if (!node.id) return null;

    var selector = '#' + escapeIdent(node.id);

    try {
      return document.querySelectorAll(selector).length === 1 ? selector : null;
    } catch (error) {
      return null;
    }
  }

  // tag.class.class:nth-of-type(n) for one level of the chain.
  function step(node) {
    var part = node.tagName.toLowerCase();
    var classes = node.classList;

    for (var i = 0; i < classes.length && i < 2; i += 1) part += '.' + escapeIdent(classes[i]);

    var parent = node.parentElement;

    if (!parent) return part;

    var index = 0;
    var count = 0;

    for (var child = parent.firstElementChild; child; child = child.nextElementSibling) {
      if (child.tagName === node.tagName) {
        count += 1;

        if (child === node) index = count;
      }
    }

    return count > 1 ? part + ':nth-of-type(' + index + ')' : part;
  }

  function selectorOf(element) {
    var parts = [];

    for (var node = element; node && node.nodeType === 1 && parts.length < 5; node = node.parentElement) {
      var id = uniqueId(node);

      if (id) {
        parts.unshift(id);

        break;
      }

      parts.unshift(step(node));
    }

    return parts.join(' > ');
  }

  // A closed shadow root keeps the page's CSS off the outline and its label.
  function overlay() {
    if (host && host.isConnected) return;

    host = document.createElement('choibuddy-pick');
    host.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483647';

    var root = typeof host.attachShadow === 'function' ? host.attachShadow({ mode: 'closed' }) : host;

    box = document.createElement('div');

    box.style.cssText = 'position:fixed;display:none;box-sizing:border-box;outline:2px solid ' + ACCENT +
      ';outline-offset:-1px;background:rgba(255,122,69,0.12);border-radius:2px;pointer-events:none';

    label = document.createElement('div');

    label.style.cssText = 'position:fixed;display:none;max-width:60vw;padding:1px 6px;border-radius:4px;background:' + ACCENT +
      ';color:#111;font:600 11px/16px ui-monospace,Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none';

    root.appendChild(box);
    root.appendChild(label);
    document.documentElement.appendChild(host);
    cursor = document.createElement('style');
    cursor.textContent = '*{cursor:crosshair!important}';
  }

  function outline(element) {
    var rect = element.getBoundingClientRect();

    if (element !== current) label.textContent = selectorOf(element);

    current = element;
    box.style.display = 'block';
    box.style.left = rect.left + 'px';
    box.style.top = rect.top + 'px';
    box.style.width = rect.width + 'px';
    box.style.height = rect.height + 'px';
    label.style.display = 'block';
    label.style.left = Math.max(0, rect.left) + 'px';
    label.style.top = (rect.top >= 20 ? rect.top - 20 : Math.min(rect.bottom + 2, window.innerHeight - 18)) + 'px';
  }

  function setPick(value) {
    on = value === true;

    try {
      if (on) {
        overlay();

        if (!cursor.isConnected) document.documentElement.appendChild(cursor);

        return;
      }

      current = null;

      if (box) {
        box.style.display = 'none';
        label.style.display = 'none';
      }

      if (cursor && cursor.parentNode) cursor.parentNode.removeChild(cursor);
    } catch (error) {
      // A page that fights the overlay only loses the highlight.
    }
  }

  function targetOf(event) {
    var element = event.target;

    return element && element.nodeType === 1 && element !== host ? element : null;
  }

  function pick(element) {
    var rect = element.getBoundingClientRect();

    var data = {
      url: clip(window.location.href, 2048),
      title: clip(document.title || '', 300),
      selector: clip(selectorOf(element), 1024),
      tag: element.tagName.toLowerCase(),
      text: clip((element.innerText || element.textContent || '').trim(), 300),
      html: clip(element.outerHTML || '', 3000),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    };

    // HTML is the only part that can grow past the message limit.
    if (encode(data).length > MAX_MESSAGE) data.html = clip(data.html, 1000);

    if (encode(data).length > MAX_MESSAGE) data.html = '';

    setPick(false);
    send('picked', data);
  }

  // Pick mode keeps the page from reacting to the click being used to pick.
  function swallow(event) {
    if (!on) return;

    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function onMove(event) {
    if (!on) return;

    try {
      var element = targetOf(event);

      if (element) outline(element);
    } catch (error) {
      // Keep following the cursor on the next move.
    }
  }

  function onScroll() {
    if (!on || !current) return;

    try {
      outline(current);
    } catch (error) {
      // The element may be gone; the next move picks a new one.
    }
  }

  function onClick(event) {
    if (!on) return;

    swallow(event);

    try {
      var element = targetOf(event) || current;

      if (element) pick(element);
    } catch (error) {
      setPick(false);
    }
  }

  function onKey(event) {
    if (!on || event.key !== 'Escape') return;

    swallow(event);
    setPick(false);
    send('cancel', {});
  }

  try {
    // Registered before any page script, so the capture phase sees them first.
    var swallowed = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'dblclick', 'auxclick', 'contextmenu'];

    for (var i = 0; i < swallowed.length; i += 1) window.addEventListener(swallowed[i], swallow, true);

    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('click', onClick, true);
    window.addEventListener('keydown', onKey, true);

    Object.defineProperty(window, '__choibuddyPick', {
      value: function (value) {
        setPick(value === true);
      }
    });
  } catch (error) {
    // Without the hooks the page just cannot be picked from.
  }
})();
