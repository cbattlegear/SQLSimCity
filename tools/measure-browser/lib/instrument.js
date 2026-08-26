/**
 * The in-page probe. Installed with `addInitScript`, so it is in place before any
 * application script runs and before the WebGL context exists.
 *
 * Everything here is measured from outside the application. Nothing in `web/src` knows
 * this exists, and nothing in `web/src` is changed to make it work — a measurement that
 * needed a hook in the code it measures would be measuring the hook as well, and would
 * stop being available on the build that actually ships.
 */

export const INSTRUMENT_SOURCE = `(() => {
  if (window.__measure) return;

  const rawRaf = window.requestAnimationFrame.bind(window);
  const now = () => performance.now();

  const state = {
    /** Draw calls and triangles since the last frame boundary, split by target. */
    live: { calls: 0, tris: 0, offCalls: 0, offTris: 0, offMs: 0, instanced: 0 },
    frames: [],
    keys: [],
    longTasks: [],
    events: [],
    collecting: false,
    /**
     * Whether the currently bound draw framebuffer is offscreen.
     *
     * three.js renders the shadow map into a WebGLRenderTarget and the visible scene into
     * the default framebuffer, so "framebuffer !== null" separates the shadow pass from the
     * camera pass without needing a handle on the renderer. Render-target work that is not
     * the shadow map (an env-map bake, say) lands in the same bucket, which is why the report
     * calls this "offscreen" rather than "shadow" and why the shadow claim is settled by
     * toggling shadows and watching this number move.
     */
    offscreen: false,
    offStart: null,
    contexts: 0,
    rendererName: null,
  };
  window.__measure = state;

  // --- WebGL: count draw submissions, split by render target ---------------------------

  const patchContext = (proto) => {
    if (!proto || proto.__measurePatched) return;
    proto.__measurePatched = true;

    const bindFramebuffer = proto.bindFramebuffer;
    proto.bindFramebuffer = function (target, framebuffer) {
      // WebGL2 can bind read and draw targets separately; only the draw target decides
      // where a subsequent draw call lands.
      const DRAW = this.DRAW_FRAMEBUFFER === undefined ? this.FRAMEBUFFER : this.DRAW_FRAMEBUFFER;
      if (target === this.FRAMEBUFFER || target === DRAW) {
        const offscreen = framebuffer !== null;
        /*
         * Time the offscreen span, not just count it.
         *
         * The shadow pass is a contiguous run of draw calls into a render target, so the
         * wall time between binding that target and unbinding it is the main-thread cost of
         * the pass — scene traversal, culling, uniform uploads and submission. It is not a
         * GPU timing (that needs EXT_disjoint_timer_query and is unavailable in most
         * browsers), but it is the part that competes with everything else on the thread,
         * and it is the part that disappears when the pass is skipped.
         */
        if (offscreen && !state.offscreen) state.offStart = now();
        else if (!offscreen && state.offscreen && state.offStart !== null) {
          state.live.offMs += now() - state.offStart;
          state.offStart = null;
        }
        state.offscreen = offscreen;
      }
      return bindFramebuffer.call(this, target, framebuffer);
    };

    // Triangle counts follow three.js's own convention in WebGLInfo.update(): a TRIANGLES
    // draw is count/3, a strip or fan is count-2, and anything else contributes no triangles.
    const triangles = (mode, count, gl) => {
      if (mode === gl.TRIANGLES) return count / 3;
      if (mode === gl.TRIANGLE_STRIP || mode === gl.TRIANGLE_FAN) return Math.max(0, count - 2);
      return 0;
    };

    const record = (gl, mode, count, instances) => {
      const tris = triangles(mode, count, gl) * instances;
      state.live.calls += 1;
      state.live.tris += tris;
      if (instances > 1) state.live.instanced += 1;
      if (state.offscreen) {
        state.live.offCalls += 1;
        state.live.offTris += tris;
      }
    };

    const wrap = (name, countArg, instanceArg) => {
      const original = proto[name];
      if (typeof original !== 'function') return;
      proto[name] = function (...args) {
        record(this, args[0], args[countArg], instanceArg === undefined ? 1 : (args[instanceArg] || 0));
        return original.apply(this, args);
      };
    };

    wrap('drawArrays', 2);
    wrap('drawElements', 1);
    wrap('drawArraysInstanced', 2, 3);
    wrap('drawElementsInstanced', 1, 4);
    wrap('drawArraysInstancedANGLE', 2, 3);
    wrap('drawElementsInstancedANGLE', 1, 4);
    wrap('drawRangeElements', 3);
  };

  patchContext(window.WebGLRenderingContext && window.WebGLRenderingContext.prototype);
  patchContext(window.WebGL2RenderingContext && window.WebGL2RenderingContext.prototype);

  // Record which GPU actually served the run. A measurement taken on SwiftShader is a
  // measurement of a software rasteriser, and quoting it as a frame time would be wrong.
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const context = getContext.call(this, type, ...rest);
    if (context && /webgl/i.test(String(type))) {
      state.contexts += 1;
      if (!state.rendererName) {
        try {
          const debug = context.getExtension('WEBGL_debug_renderer_info');
          state.rendererName = debug
            ? context.getParameter(debug.UNMASKED_RENDERER_WEBGL)
            : context.getParameter(context.RENDERER);
        } catch {
          state.rendererName = 'unavailable';
        }
      }
    }
    return context;
  };

  // --- Frames: wrap every rAF callback so its main-thread cost is attributable ----------

  let previousStart = null;
  window.requestAnimationFrame = function (callback) {
    return rawRaf((timestamp) => {
      const before = state.live;
      state.live = { calls: 0, tris: 0, offCalls: 0, offTris: 0, offMs: 0, instanced: 0 };
      const started = now();
      try {
        callback(timestamp);
      } finally {
        const cpuMs = now() - started;
        const drawn = state.live;
        state.live = before;
        // Fold this callback's counters into whatever else ran this frame.
        before.calls += drawn.calls;
        before.tris += drawn.tris;
        before.offCalls += drawn.offCalls;
        before.offTris += drawn.offTris;
        before.offMs += drawn.offMs;
        before.instanced += drawn.instanced;
        if (state.collecting && drawn.calls > 0) {
          state.frames.push({
            at: started,
            cpuMs,
            sinceLast: previousStart === null ? null : started - previousStart,
            calls: drawn.calls,
            tris: Math.round(drawn.tris),
            offCalls: drawn.offCalls,
            offTris: Math.round(drawn.offTris),
            offMs: drawn.offMs,
            instanced: drawn.instanced,
          });
          previousStart = started;
        }
      }
    });
  };

  state.resetFrames = () => {
    state.frames.length = 0;
    previousStart = null;
  };

  // --- Interaction: keydown to the paint that answers it -------------------------------

  /*
   * A capture-phase listener on the document runs before React's root listener, so t0 is
   * genuinely before any application work. The paint is caught with rAF followed by a
   * task: rAF callbacks run before style, layout and paint, so a message posted from
   * inside one is delivered after the frame it belongs to has been presented. Reading the
   * clock there is the closest a page can get to "the user can now see the answer".
   */
  const afterPaint = (fn) => {
    rawRaf(() => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => fn(now());
      channel.port2.postMessage(0);
    });
  };

  document.addEventListener(
    'keydown',
    (event) => {
      if (!state.collecting) return;
      const t0 = now();
      afterPaint((painted) => {
        state.keys.push({ key: event.key, toPaintMs: painted - t0 });
      });
    },
    true,
  );

  // Event Timing is the browser's own view of the same thing and includes presentation
  // time from the compositor. Its threshold floors at 16 ms, so it reports only the
  // keystrokes that missed a frame — which is exactly the set worth naming.
  try {
    new PerformanceObserver((list) => {
      if (!state.collecting) return;
      for (const entry of list.getEntries()) {
        state.events.push({
          name: entry.name,
          durationMs: entry.duration,
          handlerMs: entry.processingEnd - entry.processingStart,
        });
      }
    }).observe({ type: 'event', durationThreshold: 16, buffered: false });
  } catch {
    /* Event Timing is Chromium-only; its absence is reported as an empty list. */
  }

  try {
    new PerformanceObserver((list) => {
      if (!state.collecting) return;
      for (const entry of list.getEntries()) {
        state.longTasks.push({ at: entry.startTime, durationMs: entry.duration });
      }
    }).observe({ type: 'longtask', buffered: false });
  } catch {
    /* Long Tasks is Chromium-only. */
  }

  state.start = () => {
    state.frames.length = 0;
    state.keys.length = 0;
    state.longTasks.length = 0;
    state.events.length = 0;
    previousStart = null;
    state.collecting = true;
  };

  state.stop = () => {
    state.collecting = false;
    return {
      frames: state.frames.slice(),
      keys: state.keys.slice(),
      longTasks: state.longTasks.slice(),
      events: state.events.slice(),
      renderer: state.rendererName,
    };
  };
})();`
