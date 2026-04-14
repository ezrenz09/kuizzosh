(() => {
  const AUDIO_UNLOCKED_SESSION_KEY = "kuizzosh-live-audio-unlocked";

  const audioIcons = {
    active:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z"></path><path d="M15.5 8.5a5 5 0 0 1 0 7"></path><path d="M18.5 6a8.5 8.5 0 0 1 0 12"></path></svg>',
    muted:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z"></path><path d="m16 9 5 5"></path><path d="m21 9-5 5"></path></svg>',
    blocked:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z"></path><path d="M14 10a4 4 0 0 1 2 3.46"></path><path d="M20 12a8 8 0 0 0-2.34-5.66"></path><path d="M14 14a4 4 0 0 0 2-3.46"></path></svg>'
  };

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  const normalizeUrl = (value) => {
    if (!value) {
      return "";
    }

    try {
      return new URL(value, window.location.origin).toString();
    } catch (error) {
      return String(value || "");
    }
  };

  const canUseStorage = (storage) => {
    try {
      const probeKey = "__kuizzosh_audio_probe__";
      storage.setItem(probeKey, "1");
      storage.removeItem(probeKey);
      return true;
    } catch (error) {
      return false;
    }
  };

  const sessionStorageEnabled = canUseStorage(window.sessionStorage);

  const writeSession = (key, value) => {
    if (!sessionStorageEnabled) {
      return;
    }

    window.sessionStorage.setItem(key, value);
  };

  const createAudioButtonMarkup = (state) => {
    const icon =
      state === "muted"
        ? audioIcons.muted
        : state === "blocked"
          ? audioIcons.blocked
          : audioIcons.active;
    const eyebrow =
      state === "muted"
        ? "Sound muted"
        : state === "blocked"
          ? "Tap to enable"
          : "Now playing";
    const label =
      state === "muted"
        ? "Music Off"
        : state === "blocked"
          ? "Enable Music"
          : "Music On";

    return `
      <span class="quiz-live-audio-toggle-icon" aria-hidden="true">${icon}</span>
      <span class="quiz-live-audio-toggle-copy">
        <span>${eyebrow}</span>
        <strong>${label}</strong>
      </span>
    `;
  };

  window.createQuizLiveAudioController = (options = {}) => {
    const tracks = options.tracks || {};
    const trackStartOffsets = options.trackStartOffsets || {};
    const resolveTrack =
      typeof options.resolveTrack === "function"
        ? options.resolveTrack
        : (snapshot) => (snapshot?.status === "lobby" ? "lobby" : snapshot?.status ? "live" : "");
    const themeClass = options.theme === "light" ? "is-light" : "is-dark";
    const audio = new Audio();
    const targetVolume = clamp(Number(options.volume) || 0.34, 0, 1);

    audio.preload = "auto";
    audio.loop = false;
    audio.volume = targetVolume;

    let desiredTrackKey = "";
    let currentTrackUrl = "";
    let blocked = false;
    let destroyed = false;
    let muted = false;
    let autoplayBootstrapTrackUrl = "";
    const autoplayRetryTimers = [];
    const button = document.createElement("button");

    button.type = "button";
    button.className = `quiz-live-audio-toggle ${themeClass}`;
    button.setAttribute("aria-live", "polite");

    const updateButton = () => {
      const buttonState = muted ? "muted" : blocked ? "blocked" : "active";
      button.classList.toggle("is-muted", muted);
      button.classList.toggle("is-blocked", !muted && blocked);
      button.classList.toggle("is-active", !muted && !blocked);
      button.innerHTML = createAudioButtonMarkup(buttonState);
      button.setAttribute(
        "aria-label",
        muted ? "Unmute quiz music" : blocked ? "Enable quiz music" : "Mute quiz music"
      );
    };

    const pauseAudio = () => {
      audio.pause();
    };

    const clearAutoplayRetryTimers = () => {
      while (autoplayRetryTimers.length) {
        window.clearTimeout(autoplayRetryTimers.pop());
      }
    };

    const markUnlocked = () => {
      writeSession(AUDIO_UNLOCKED_SESSION_KEY, "1");
    };

    const getTrackStartOffset = () => {
      const offset = Number(trackStartOffsets[desiredTrackKey]) || 0;
      const duration = Number(audio.duration || 0);
      const maxOffset = duration ? Math.max(0, duration - 0.35) : offset;

      return clamp(offset, 0, maxOffset || offset || 0);
    };

    const applyTrackStartOffset = () => {
      const startOffset = getTrackStartOffset();

      if (!startOffset) {
        return;
      }

      try {
        if (Math.abs(audio.currentTime - startOffset) > 0.18) {
          audio.currentTime = startOffset;
        }
      } catch (error) {
        // wait until metadata is ready
      }
    };

    const waitForTrackReady = () =>
      new Promise((resolve) => {
        if (audio.readyState >= 1) {
          applyTrackStartOffset();
          resolve();
          return;
        }

        const handleReady = () => {
          applyTrackStartOffset();
          resolve();
        };

        const handleError = () => {
          resolve();
        };

        audio.addEventListener("loadedmetadata", handleReady, { once: true });
        audio.addEventListener("error", handleError, { once: true });
      });

    const syncPlayback = async (userInitiated = false) => {
      if (destroyed) {
        return;
      }

      const desiredTrackUrl = normalizeUrl(tracks[desiredTrackKey] || "");

      if (!desiredTrackUrl || muted) {
        blocked = false;
        pauseAudio();
        updateButton();
        return;
      }

      if (currentTrackUrl !== desiredTrackUrl) {
        currentTrackUrl = desiredTrackUrl;
        autoplayBootstrapTrackUrl = "";
        clearAutoplayRetryTimers();
        pauseAudio();
        audio.src = desiredTrackUrl;
        audio.currentTime = 0;
        await waitForTrackReady();
      }

      const useAutoplayBootstrap = !userInitiated && autoplayBootstrapTrackUrl !== currentTrackUrl;

      try {
        if (useAutoplayBootstrap) {
          autoplayBootstrapTrackUrl = currentTrackUrl;
          audio.muted = true;
          audio.volume = 0;
        } else {
          audio.muted = false;
          audio.volume = targetVolume;
        }

        await audio.play();
        blocked = false;
        markUnlocked();

        if (useAutoplayBootstrap) {
          window.setTimeout(() => {
            if (destroyed || muted || currentTrackUrl !== desiredTrackUrl) {
              return;
            }

            audio.muted = false;
            audio.volume = targetVolume;
          }, 140);
        }
      } catch (error) {
        blocked = true;
      }

      updateButton();
    };

    const restartTrackFromOffset = () => {
      if (!currentTrackUrl || muted || destroyed) {
        return;
      }

      applyTrackStartOffset();
      syncPlayback(true);
    };

    const handleFirstInteraction = () => {
      if (!desiredTrackKey || muted) {
        return;
      }

      markUnlocked();
      syncPlayback(true);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible" && !muted && desiredTrackKey) {
        syncPlayback(false);
      }
    };

    const handleWindowLoad = () => {
      if (!muted && desiredTrackKey) {
        syncPlayback(false);
      }
    };

    const scheduleAutoplayRetries = () => {
      clearAutoplayRetryTimers();

      [450, 1400, 2600].forEach((delayMs) => {
        const timerId = window.setTimeout(() => {
          if (destroyed || muted || !desiredTrackKey || !blocked) {
            return;
          }

          syncPlayback(false);
        }, delayMs);

        autoplayRetryTimers.push(timerId);
      });
    };

    audio.addEventListener("ended", restartTrackFromOffset);
    audio.addEventListener("loadedmetadata", applyTrackStartOffset);

    button.addEventListener("click", async () => {
      if (muted) {
        muted = false;
        markUnlocked();
        await syncPlayback(true);
        return;
      }

      if (blocked) {
        markUnlocked();
        await syncPlayback(true);
        return;
      }

      muted = true;
      pauseAudio();
      blocked = false;
      updateButton();
    });

    document.addEventListener("pointerdown", handleFirstInteraction, { passive: true });
    document.addEventListener("keydown", handleFirstInteraction);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("load", handleWindowLoad);
    window.addEventListener("pageshow", handleWindowLoad);

    (options.mount || document.body).appendChild(button);
    updateButton();

    return {
      sync(snapshot) {
        desiredTrackKey = resolveTrack(snapshot);
        syncPlayback(false);
        scheduleAutoplayRetries();
      },
      destroy() {
        destroyed = true;
        clearAutoplayRetryTimers();
        pauseAudio();
        audio.removeEventListener("ended", restartTrackFromOffset);
        audio.removeEventListener("loadedmetadata", applyTrackStartOffset);
        document.removeEventListener("pointerdown", handleFirstInteraction);
        document.removeEventListener("keydown", handleFirstInteraction);
        document.removeEventListener("visibilitychange", handleVisibilityChange);
        window.removeEventListener("load", handleWindowLoad);
        window.removeEventListener("pageshow", handleWindowLoad);
        if (button.isConnected) {
          button.remove();
        }
      }
    };
  };

  window.markQuizLiveAudioUnlocked = () => {
    writeSession(AUDIO_UNLOCKED_SESSION_KEY, "1");
  };
})();
