const fastClickJoinGate = document.querySelector("[data-fast-click-join-gate]");
const fastClickJoinHeading = document.querySelector("[data-fast-click-join-heading]");
const fastClickJoinStatusText = document.querySelector("[data-fast-click-join-status-text]");
const fastClickJoinForm = document.querySelector("[data-fast-click-join-form]");
const fastClickJoinSubmitButton = document.querySelector("[data-fast-click-join-submit]");
const fastClickJoinNote = document.querySelector("[data-fast-click-join-note]");
const fastClickJoinLateNote = document.querySelector("[data-fast-click-join-late-note]");
const fastClickJoinCountNode = document.querySelector("[data-fast-click-join-count]");
const fastClickJoinCountHeroNode = document.querySelector("[data-fast-click-join-count-hero]");
const fastClickJoinCountLabelNode = document.querySelector("[data-fast-click-join-count-label]");
const fastClickJoinStateChip = document.querySelector("[data-fast-click-join-state-chip]");
const fastClickJoinStateLabel = document.querySelector("[data-fast-click-join-state-label]");
const fastClickPlayerShell = document.querySelector("[data-fast-click-player]");
const fastClickPlayerDataScript = document.querySelector("[data-fast-click-player-data]");

if (fastClickJoinGate && !fastClickPlayerShell) {
  const stateUrl = `/api${window.location.pathname}/state`;
  let realtimeSubscription = null;
  let realtimeSessionId = null;

  const setJoinCount = (count) => {
    const safeCount = Number.isFinite(count) ? Math.max(0, count) : 0;
    const label =
      safeCount === 1 ? "1 player is already in the room." : `${safeCount} players are already in the room.`;

    if (fastClickJoinCountNode) {
      fastClickJoinCountNode.textContent = String(safeCount);
    }

    if (fastClickJoinCountHeroNode) {
      fastClickJoinCountHeroNode.textContent = String(safeCount);
    }

    if (fastClickJoinCountLabelNode) {
      fastClickJoinCountLabelNode.textContent = label;
    }
  };

  const setJoinState = (joinState) => {
    const isLobby = joinState === "lobby";
    const isFinished = joinState === "finished";

    if (fastClickJoinHeading) {
      fastClickJoinHeading.textContent = isLobby
        ? "You can join now"
        : isFinished
          ? "Session ended"
          : "Opss, you're late.";
    }

    if (fastClickJoinStatusText) {
      fastClickJoinStatusText.textContent = isLobby
        ? "The room is open. Enter your nickname and get ready."
        : isFinished
          ? "This fast click room is already finished."
          : "The round has already started, so new players cannot join now.";
    }

    if (fastClickJoinForm) {
      fastClickJoinForm.hidden = !isLobby;
    }

    if (fastClickJoinSubmitButton) {
      fastClickJoinSubmitButton.disabled = !isLobby;
    }

    if (fastClickJoinNote) {
      fastClickJoinNote.hidden = !isLobby;
    }

    if (fastClickJoinLateNote) {
      fastClickJoinLateNote.hidden = isLobby;
    }

    if (fastClickJoinStateChip) {
      fastClickJoinStateChip.classList.toggle("is-live", isLobby);
      fastClickJoinStateChip.classList.toggle("is-late", !isLobby);
      fastClickJoinStateChip.classList.toggle("is-waiting", false);
    }

    if (fastClickJoinStateLabel) {
      fastClickJoinStateLabel.textContent = isLobby
        ? "Lobby Open"
        : isFinished
          ? "Finished"
          : "Started";
    }
  };

  const applyJoinPayload = (payload = {}) => {
    const nextSnapshot = payload.snapshot || null;
    const joinState =
      payload.joinState ||
      (nextSnapshot?.status === "lobby"
        ? "lobby"
        : nextSnapshot?.status === "finished"
          ? "finished"
          : "late");

    setJoinState(joinState);
    setJoinCount(Number(payload.participantCount ?? nextSnapshot?.participantCount ?? 0));

    if (payload.participant) {
      window.location.reload();
      return;
    }

    const nextSessionId =
      Number.parseInt(String(nextSnapshot?.sessionId || payload.realtime?.sessionId || ""), 10) || null;

    if (
      nextSessionId &&
      nextSessionId !== realtimeSessionId &&
      typeof window.createQuizLiveRealtimeSubscription === "function"
    ) {
      Promise.resolve(realtimeSubscription?.unsubscribe?.())
        .catch(() => {})
        .finally(async () => {
          realtimeSessionId = nextSessionId;
          realtimeSubscription = await window.createQuizLiveRealtimeSubscription({
            sessionId: nextSessionId,
            channelName: window.getQuizLiveRealtimeConfig(nextSessionId)?.channelName,
            onSnapshot: (snapshot) => {
              applyJoinPayload({
                snapshot,
                joinState:
                  snapshot?.status === "lobby"
                    ? "lobby"
                    : snapshot?.status === "finished"
                      ? "finished"
                      : "late",
                participantCount: snapshot?.participantCount || 0
              });
            }
          });
        });
    }
  };

  const loadJoinState = async () => {
    const response = await fetch(stateUrl, {
      cache: "no-store",
      headers: {
        Accept: "application/json"
      }
    });

    if (!response.ok) {
      return;
    }

    const payload = await response.json();
    applyJoinPayload(payload);
  };

  loadJoinState().catch(() => {});
  window.setInterval(() => {
    loadJoinState().catch(() => {});
  }, 4000);

  window.addEventListener("beforeunload", () => {
    Promise.resolve(realtimeSubscription?.unsubscribe?.()).catch(() => {});
  });
}

if (fastClickPlayerShell && fastClickPlayerDataScript) {
  const stateUrl = fastClickPlayerShell.dataset.stateUrl || "";
  const clickUrl = fastClickPlayerShell.dataset.clickUrl || "";
  const initialPlayerName =
    document.querySelector(".quiz-player-identity strong")?.textContent || "Player";
  const STATE_POLL_INTERVAL_MS = 15000;
  const PHASE_SYNC_INTERVAL_MS = 150;
  let liveSnapshot = {};
  let actionPending = false;
  let boundarySyncKey = "";
  let serverClockOffsetMs = 0;
  let realtimeSubscription = null;
  let realtimeSessionId = null;

  const playerIcons = {
    spark:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8Z"></path></svg>',
    users:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="3"></circle><path d="M22 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>',
    clock:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 3"></path></svg>',
    pulse:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h4l2-5 4 10 2-5h6"></path></svg>',
    trophy:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 21h8"></path><path d="M12 17v4"></path><path d="M7 4h10v4a5 5 0 0 1-10 0Z"></path><path d="M17 6h2a2 2 0 0 1 0 4h-2"></path><path d="M7 6H5a2 2 0 1 0 0 4h2"></path></svg>',
    tap:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 11V5a1 1 0 0 1 2 0v5"></path><path d="M12 11V4a1 1 0 0 1 2 0v7"></path><path d="M15 11V6a1 1 0 0 1 2 0v7"></path><path d="M18 11a1 1 0 0 1 2 0v4a7 7 0 0 1-7 7h-1a7 7 0 0 1-6.2-3.76L4 15a1 1 0 0 1 1.8-.88L8 17V9a1 1 0 0 1 2 0v2"></path></svg>'
  };

  try {
    liveSnapshot = JSON.parse(fastClickPlayerDataScript.textContent || "{}");
  } catch (error) {
    liveSnapshot = {};
  }

  const escapeHtml = (value) =>
    String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");

  const syncServerClock = (snapshot) => {
    const serverNowMs = snapshot?.serverNow ? new Date(snapshot.serverNow).getTime() : 0;

    if (serverNowMs) {
      serverClockOffsetMs = serverNowMs - Date.now();
    }
  };

  const getNowMs = () => Date.now() + serverClockOffsetMs;

  const formatCountdown = (deadlineAt) => {
    if (!deadlineAt) {
      return "--";
    }

    const diffMs = new Date(deadlineAt).getTime() - getNowMs();
    return `${Math.max(0, Math.ceil(diffMs / 1000))}s`;
  };

  const formatCountdownNumber = (deadlineAt) => {
    if (!deadlineAt) {
      return "0";
    }

    const diffMs = new Date(deadlineAt).getTime() - getNowMs();
    return String(Math.max(0, Math.ceil(diffMs / 1000)));
  };

  const formatMillisecondsLabel = (value) => `${(Number(value || 0) / 1000).toFixed(3)}s`;

  const getBoundaryKey = (snapshot) =>
    `${snapshot.status || ""}:${snapshot.phaseEndsAt || ""}:${snapshot.greenStartsAt || ""}`;

  const renderIcon = (iconName) => playerIcons[iconName] || playerIcons.spark;

  const renderChip = (iconName, label, value, extraClass = "", valueAttributes = "") => `
    <div class="fast-click-chip ${extraClass}">
      <span class="fast-click-chip-icon" aria-hidden="true">${renderIcon(iconName)}</span>
      <span class="fast-click-chip-copy">
        <span>${escapeHtml(label)}</span>
        <strong ${valueAttributes}>${escapeHtml(value)}</strong>
      </span>
    </div>
  `;

  const mergeParticipantIntoSnapshot = (nextSnapshot) => {
    if (!nextSnapshot) {
      return nextSnapshot;
    }

    if (nextSnapshot.participant) {
      return nextSnapshot;
    }

    const currentParticipant = liveSnapshot.participant;

    if (!currentParticipant) {
      return nextSnapshot;
    }

    const leaderboardEntry = (nextSnapshot.leaderboard || []).find(
      (entry) => String(entry.participantId || "") === String(currentParticipant.id || "")
    );
    const reactionTimeMs = Number.isFinite(Number(currentParticipant.reactionTimeMs))
      ? Number(currentParticipant.reactionTimeMs)
      : Number.isFinite(Number(leaderboardEntry?.reactionTimeMs))
        ? Number(leaderboardEntry.reactionTimeMs)
        : null;

    return {
      ...nextSnapshot,
      participant: {
        ...currentParticipant,
        hasClicked: Boolean(currentParticipant.hasClicked || leaderboardEntry),
        reactionTimeMs,
        reactionTimeLabel:
          reactionTimeMs !== null
            ? formatMillisecondsLabel(reactionTimeMs)
            : currentParticipant.reactionTimeLabel || "",
        rank: leaderboardEntry?.rank || currentParticipant.rank || null
      }
    };
  };

  const renderLeaderboard = (snapshot) => {
    if (!snapshot.leaderboard?.length) {
      return '<p class="fast-click-empty-note">Ranking will appear after the first valid tap.</p>';
    }

    return `
      <div class="fast-click-rank-list">
        ${snapshot.leaderboard
          .slice(0, 10)
          .map(
            (entry) => `
              <article class="fast-click-rank-row is-light ${snapshot.participant?.id === entry.participantId ? "is-active" : ""}">
                <span class="fast-click-rank-number">${entry.rank}</span>
                <div class="fast-click-rank-copy">
                  <strong>${escapeHtml(entry.displayName)}</strong>
                  <span>${escapeHtml(entry.participantId === snapshot.participant?.id ? "You" : "Player")}</span>
                </div>
                <strong>${escapeHtml(entry.reactionTimeLabel)}</strong>
              </article>
            `
          )
          .join("")}
      </div>
    `;
  };

  const renderWaitingStage = (snapshot) => `
    <section class="quiz-player-waiting-shell">
      <div class="quiz-player-waiting-topline">
        <span class="quiz-player-waiting-topicon" aria-hidden="true">${renderIcon("tap")}</span>
        <span>Fast Click</span>
      </div>

      <section class="quiz-player-waiting-card">
        <div class="quiz-player-waiting-check" aria-hidden="true">
          <span class="quiz-player-waiting-check-ring quiz-player-waiting-check-ring-a"></span>
          <span class="quiz-player-waiting-check-ring quiz-player-waiting-check-ring-b"></span>
          <span class="quiz-player-waiting-check-icon">${renderIcon("spark")}</span>
        </div>

        <div class="quiz-player-waiting-copy">
          <h2>Get ready, ${escapeHtml(initialPlayerName)}!</h2>
          <p>${escapeHtml(
            snapshot.participantCount === 1
              ? "1 player is in the room waiting for the start."
              : `${snapshot.participantCount || 0} players are in the room waiting for the start.`
          )}</p>
        </div>
      </section>
    </section>
  `;

  const renderSignalStage = (snapshot) => {
    const isCountdown = snapshot.status === "countdown";
    const isRed = snapshot.status === "red";
    const isGreen = snapshot.status === "green";
    const title = isCountdown ? "Countdown" : isRed ? "Wait for green" : "Tap now";
    const helper = isCountdown
      ? "The red signal starts as soon as the countdown reaches zero."
      : isRed
        ? "Stay ready and do not tap yet."
        : "Tap the button as fast as you can.";

    return `
      <section class="fast-click-player-stage">
        <article class="fast-click-player-card">
          <div class="fast-click-player-head">
            <div class="fast-click-player-copy">
              <span class="section-pill">Fast Click</span>
              <h2>${escapeHtml(title)}</h2>
              <p>${escapeHtml(helper)}</p>
            </div>

            <div class="fast-click-player-chip-row">
              ${renderChip("users", "Players", String(snapshot.participantCount || 0))}
              ${
                isCountdown || isRed
                  ? renderChip(
                      "clock",
                      "Time left",
                      formatCountdown(snapshot.phaseEndsAt),
                      "is-countdown",
                      'data-fast-click-player-countdown-small=""'
                    )
                  : renderChip("pulse", "Clicked", String(snapshot.clickedCount || 0))
              }
            </div>
          </div>

          <div class="fast-click-signal-wrap">
            ${
              isCountdown
                ? `<div class="fast-click-countdown-number" data-fast-click-player-countdown-big>${formatCountdownNumber(snapshot.phaseEndsAt)}</div>`
                : `<div class="fast-click-signal-light ${isRed ? "is-red" : "is-green"}"></div>`
            }

            ${
              isGreen
                ? `
                  <button
                    type="button"
                    class="fast-click-action-button is-green"
                    data-fast-click-tap
                    ${actionPending ? "disabled" : ""}
                  >
                    Tap Now
                  </button>
                `
                : `
                  <button type="button" class="fast-click-action-button is-red" disabled>
                    ${escapeHtml(isCountdown ? "Hold steady" : "Wait for green")}
                  </button>
                `
            }
          </div>
        </article>
      </section>
    `;
  };

  const renderResultStage = (snapshot) => `
    <section class="fast-click-player-stage">
      <article class="fast-click-player-card">
        <div class="fast-click-result-highlight">
          <span class="section-pill">${escapeHtml(snapshot.status === "finished" ? "Final Result" : "Your Reaction Time")}</span>
          <h2>${escapeHtml(snapshot.participant?.displayName || initialPlayerName)}</h2>
          <div class="fast-click-result-time">${escapeHtml(snapshot.participant?.reactionTimeLabel || "--")}</div>
          <p>
            ${
              snapshot.participant?.rank
                ? escapeHtml(`You are currently #${snapshot.participant.rank}.`)
                : "Waiting for your place..."
            }
          </p>
        </div>
      </article>

      <article class="fast-click-player-card">
        <div class="fast-click-player-copy">
          <span class="section-pill">Top 10</span>
          <h2>Live ranking</h2>
          <p>The ranking updates as more players record a valid tap.</p>
        </div>
        ${renderLeaderboard(snapshot)}
      </article>
    </section>
  `;

  const renderMissedStage = (snapshot) => `
    <section class="fast-click-player-stage">
      <article class="fast-click-player-card">
        <div class="fast-click-result-highlight">
          <span class="section-pill">Round Finished</span>
          <h2>Too late</h2>
          <div class="fast-click-result-time">--</div>
          <p>${escapeHtml(
            snapshot.clickedCount
              ? "Other players already recorded their reaction times."
              : "No valid reaction time was recorded from your screen."
          )}</p>
        </div>
      </article>
    </section>
  `;

  const render = (snapshot) => {
    liveSnapshot = snapshot || {};
    syncServerClock(liveSnapshot);
    ensureRealtimeSubscription(liveSnapshot.sessionId).catch(() => {});

    let stageMarkup = "";

    if (liveSnapshot.status === "lobby") {
      stageMarkup = renderWaitingStage(liveSnapshot);
    } else if (
      (liveSnapshot.status === "green" || liveSnapshot.status === "finished") &&
      liveSnapshot.participant?.hasClicked
    ) {
      stageMarkup = renderResultStage(liveSnapshot);
    } else if (liveSnapshot.status === "countdown" || liveSnapshot.status === "red" || liveSnapshot.status === "green") {
      stageMarkup = renderSignalStage(liveSnapshot);
    } else {
      stageMarkup = renderMissedStage(liveSnapshot);
    }

    fastClickPlayerShell.innerHTML = `
      <div class="quiz-player-live-flow">
        <div class="quiz-player-identity">
          <span>Playing as</span>
          <strong>${escapeHtml(initialPlayerName)}</strong>
        </div>
        ${stageMarkup}
      </div>
    `;
  };

  const ensureRealtimeSubscription = async (sessionId) => {
    const nextSessionId = Number.parseInt(String(sessionId || ""), 10);

    if (
      !Number.isInteger(nextSessionId) ||
      nextSessionId <= 0 ||
      realtimeSessionId === nextSessionId ||
      typeof window.createQuizLiveRealtimeSubscription !== "function"
    ) {
      return;
    }

    await Promise.resolve(realtimeSubscription?.unsubscribe?.()).catch(() => {});
    realtimeSessionId = nextSessionId;
    realtimeSubscription = await window.createQuizLiveRealtimeSubscription({
      sessionId: nextSessionId,
      channelName: window.getQuizLiveRealtimeConfig(nextSessionId)?.channelName,
      onSnapshot: (snapshot) => {
        boundarySyncKey = "";
        render(mergeParticipantIntoSnapshot(snapshot || {}));
      }
    });
  };

  const loadState = async () => {
    const response = await fetch(stateUrl, {
      cache: "no-store",
      headers: {
        Accept: "application/json"
      }
    });

    if (!response.ok) {
      throw new Error("Unable to refresh the fast click state.");
    }

    const payload = await response.json();

    if (payload.snapshot) {
      boundarySyncKey = "";
      render(payload.snapshot);
    }
  };

  const submitClick = async () => {
    if (actionPending || liveSnapshot.status !== "green" || liveSnapshot.participant?.hasClicked) {
      return;
    }

    actionPending = true;
    render(liveSnapshot);

    try {
      const response = await fetch(clickUrl, {
        method: "POST",
        headers: {
          Accept: "application/json"
        }
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Unable to record your reaction time.");
      }

      if (payload.snapshot) {
        boundarySyncKey = "";
        render(payload.snapshot);
      }
    } catch (error) {
      window.alert(error.message);
    } finally {
      actionPending = false;
      render(liveSnapshot);
    }
  };

  fastClickPlayerShell.addEventListener("click", (event) => {
    if (event.target.closest("[data-fast-click-tap]")) {
      submitClick();
    }
  });

  render(liveSnapshot);

  window.setInterval(() => {
    loadState().catch(() => {});
  }, STATE_POLL_INTERVAL_MS);

  window.setInterval(() => {
    fastClickPlayerShell.querySelectorAll("[data-fast-click-player-countdown-small]").forEach((node) => {
      node.textContent = formatCountdown(liveSnapshot.phaseEndsAt);
    });

    fastClickPlayerShell.querySelectorAll("[data-fast-click-player-countdown-big]").forEach((node) => {
      node.textContent = formatCountdownNumber(liveSnapshot.phaseEndsAt);
    });

    if (liveSnapshot.phaseEndsAt) {
      const phaseDeadline = new Date(liveSnapshot.phaseEndsAt).getTime();
      const currentBoundaryKey = getBoundaryKey(liveSnapshot);

      if (getNowMs() >= phaseDeadline && currentBoundaryKey && boundarySyncKey !== currentBoundaryKey) {
        boundarySyncKey = currentBoundaryKey;
        loadState().catch(() => {});
      }
    }
  }, PHASE_SYNC_INTERVAL_MS);

  window.addEventListener("beforeunload", () => {
    Promise.resolve(realtimeSubscription?.unsubscribe?.()).catch(() => {});
  });
}
