const quizJoinGate = document.querySelector("[data-quiz-join-gate]");
const quizJoinStatusText = document.querySelector("[data-quiz-join-status-text]");
const quizJoinSubmitButton = document.querySelector("[data-quiz-join-submit]");
const quizJoinStateChip = document.querySelector("[data-quiz-join-state-chip]");
const quizJoinStateLabel = document.querySelector("[data-quiz-join-state-label]");
const quizJoinCountValue = document.querySelector("[data-quiz-join-count-value]");
const quizJoinCountHero = document.querySelector("[data-quiz-join-count-hero]");
const quizJoinCountLabel = document.querySelector("[data-quiz-join-count-label]");
const quizJoinHeading = document.querySelector("[data-quiz-join-heading]");
const quizJoinForm = document.querySelector("[data-quiz-join-form]");
const quizJoinNote = document.querySelector("[data-quiz-join-note]");
const quizJoinLateNote = document.querySelector("[data-quiz-join-late-note]");
const quizLivePlayerShell = document.querySelector("[data-quiz-live-player]");
const quizLivePlayerDataScript = document.querySelector("[data-quiz-live-player-data]");

if (quizJoinGate && !quizLivePlayerShell) {
  const stateUrl = `/api${window.location.pathname}/state`;

  if (quizJoinForm) {
    quizJoinForm.addEventListener("submit", () => {
      if (typeof window.markQuizLiveAudioUnlocked === "function") {
        window.markQuizLiveAudioUnlocked();
      }
    });
  }

  const setJoinState = (stateOrActive) => {
    const joinState =
      typeof stateOrActive === "string"
        ? stateOrActive
        : stateOrActive
          ? "lobby"
          : "waiting";
    const isActive = joinState === "lobby";
    const isLate = joinState === "late";

    quizJoinGate.dataset.sessionActive = String(isActive);
    quizJoinGate.dataset.joinState = joinState;

    if (quizJoinSubmitButton) {
      quizJoinSubmitButton.disabled = !isActive;
    }

    if (quizJoinHeading) {
      quizJoinHeading.textContent = isActive
        ? "You can join now"
        : isLate
          ? "Opss, you're late."
          : "Waiting for host to start";
    }

    if (quizJoinStatusText) {
      quizJoinStatusText.textContent = isActive
        ? "The lobby is open. Enter your nickname and jump in."
        : isLate
          ? "Join next session! This game is already in progress, so new players cannot enter now."
          : "This quiz is not live yet. Keep this page open and join as soon as the host starts the room.";
    }

    if (quizJoinStateChip) {
      quizJoinStateChip.classList.toggle("is-live", isActive);
      quizJoinStateChip.classList.toggle("is-waiting", !isActive && !isLate);
      quizJoinStateChip.classList.toggle("is-late", isLate);
    }

    if (quizJoinStateLabel) {
      quizJoinStateLabel.textContent = isActive ? "Lobby Open" : isLate ? "Started" : "Waiting";
    }

    if (quizJoinForm) {
      quizJoinForm.hidden = isLate;
    }

    if (quizJoinNote) {
      quizJoinNote.hidden = isLate;
    }

    if (quizJoinLateNote) {
      quizJoinLateNote.hidden = !isLate;
    }
  };

  const setJoinCount = (count) => {
    const safeCount = Number.isFinite(count) ? Math.max(0, count) : 0;
    const joinedLabel =
      safeCount === 1 ? "1 player is already in the room." : `${safeCount} players are already in the room.`;

    if (quizJoinCountValue) {
      quizJoinCountValue.textContent = String(safeCount);
    }

    if (quizJoinCountHero) {
      quizJoinCountHero.textContent = String(safeCount);
    }

    if (quizJoinCountLabel) {
      quizJoinCountLabel.textContent = joinedLabel;
    }
  };

  window.setInterval(async () => {
    try {
      const response = await fetch(stateUrl, {
        headers: {
          Accept: "application/json"
        }
      });

      if (!response.ok) {
        return;
      }

      const payload = await response.json();
      setJoinState(payload.joinState || (payload.activeSession ? "lobby" : "waiting"));
      setJoinCount(Number(payload.participantCount || 0));

      if (payload.participant) {
        window.location.reload();
      }
    } catch (error) {
      // keep current gate state
    }
  }, 2000);
}

if (quizLivePlayerShell && quizLivePlayerDataScript) {
  const stateUrl = quizLivePlayerShell.dataset.stateUrl || "";
  const answerUrl = quizLivePlayerShell.dataset.answerUrl || "";
  const initialPlayerName =
    document.querySelector(".quiz-player-identity strong")?.textContent || "Player";
  let liveSnapshot = {};
  let actionPending = false;
  let selectedChoiceIds = [];
  let selectingChoiceIds = [];
  let lastRenderedQuestionId = null;
  let boundarySyncKey = "";
  let wrongAnswerPopupQuestionId = null;
  let wrongAnswerPopupVisible = false;
  let wrongAnswerPopupTimer = null;
  let animatedChoiceStatsKey = "";
  const audioController =
    typeof window.createQuizLiveAudioController === "function"
      ? window.createQuizLiveAudioController({
          theme: "light",
          volume: 0.3,
          tracks: {
            lobby: "/audio/lobby/lobby-theme.mp3",
            live: "/audio/live/live-theme.mp3",
            final: "/audio/final/final-theme.mp3"
          },
          trackStartOffsets: {
            lobby: 2.4,
            live: 2.4,
            final: 2.4
          },
          resolveTrack: (snapshot) => {
            if (!snapshot?.status) {
              return "";
            }

            if (snapshot.status === "ended") {
              return "final";
            }

            return snapshot.status === "lobby" ? "lobby" : "live";
          }
        })
      : null;

  try {
    liveSnapshot = JSON.parse(quizLivePlayerDataScript.textContent || "{}");
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

  const formatCountdown = (deadlineAt) => {
    if (!deadlineAt) {
      return "";
    }

    const diffMs = new Date(deadlineAt).getTime() - Date.now();
    return `${Math.max(0, Math.ceil(diffMs / 1000))}s`;
  };

  const formatCountdownNumber = (deadlineAt) => {
    if (!deadlineAt) {
      return "0";
    }

    const diffMs = new Date(deadlineAt).getTime() - Date.now();
    return String(Math.max(0, Math.ceil(diffMs / 1000)));
  };

  const getQuestionTimebarProgress = (snapshot) => {
    const startedAtMs = snapshot.questionStartedAt ? new Date(snapshot.questionStartedAt).getTime() : 0;
    const endsAtMs = snapshot.phaseEndsAt ? new Date(snapshot.phaseEndsAt).getTime() : 0;

    if (!startedAtMs || !endsAtMs || endsAtMs <= startedAtMs) {
      return 1;
    }

    const totalMs = Math.max(1, endsAtMs - startedAtMs);
    const remainingMs = Math.max(0, endsAtMs - Date.now());

    return Math.min(1, remainingMs / totalMs);
  };

  const renderQuestionTimebar = (snapshot) => {
    const progress = getQuestionTimebarProgress(snapshot);
    const progressPercent = Math.max(0, Math.min(100, progress * 100));
    const dangerClass = progress <= 0.22 ? "is-danger" : progress <= 0.45 ? "is-warning" : "";

    return `
      <div class="quiz-player-timebar ${dangerClass}" aria-hidden="true">
        <span
          class="quiz-player-timebar-fill"
          data-player-timebar-fill
          style="width:${progressPercent}%"
        ></span>
      </div>
    `;
  };

  const getChoiceTone = (index) =>
    ["choice-red", "choice-blue", "choice-yellow", "choice-green"][index % 4];

  const getCurrentBoundaryKey = (snapshot) =>
    `${snapshot.status || ""}:${snapshot.phaseMode || ""}:${snapshot.phaseEndsAt || ""}`;

  const formatJoinedParticipants = (count) => {
    const safeCount = Number.isFinite(count) ? Math.max(0, count) : 0;
    return safeCount === 1 ? "1 participant has already joined" : `${safeCount} participants have already joined`;
  };
  const playerIcons = {
    trophy:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 21h8"></path><path d="M12 17v4"></path><path d="M7 4h10v4a5 5 0 0 1-10 0Z"></path><path d="M17 6h2a2 2 0 0 1 0 4h-2"></path><path d="M7 6H5a2 2 0 1 0 0 4h2"></path></svg>',
    pulse:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h4l2-5 4 10 2-5h6"></path></svg>',
    clock:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 3"></path></svg>',
    chart:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20V10"></path><path d="M10 20V4"></path><path d="M16 20v-7"></path><path d="M22 20v-3"></path></svg>',
    spark:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8Z"></path></svg>',
    crown:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 8 5 4 4-6 4 6 5-4-2 10H5Z"></path><path d="M5 18h14"></path></svg>',
    users:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="3"></circle><path d="M22 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>',
    check:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 13 4 4L19 7"></path></svg>'
  };
  const choiceLetters = ["A", "B", "C", "D", "E", "F"];
  const renderPlayerIcon = (iconName) => playerIcons[iconName] || playerIcons.spark;
  const renderMetaChip = (iconName, label, value, extraClass = "", valueAttributes = "") => `
    <div class="quiz-player-stage-meta-chip ${extraClass}">
      <span class="quiz-player-stage-meta-icon" aria-hidden="true">${renderPlayerIcon(iconName)}</span>
      <span class="quiz-player-stage-meta-copy">
        <span>${escapeHtml(label)}</span>
        <strong ${valueAttributes}>${escapeHtml(value)}</strong>
      </span>
    </div>
  `;
  const renderStageShell = ({ iconName, label, title, description, chips = [], body = "", stageClass = "" }) => `
    <section class="quiz-player-stage-card ${stageClass}">
      <header class="quiz-player-stage-header">
        <div class="quiz-player-stage-brand">
          <span class="quiz-player-stage-icon" aria-hidden="true">${renderPlayerIcon(iconName)}</span>
          <div class="quiz-player-stage-brand-copy">
            <span class="section-pill">${escapeHtml(label)}</span>
            <span class="quiz-player-stage-brand-hint">Player screen</span>
          </div>
        </div>
        ${chips.length ? `<div class="quiz-player-stage-meta-row">${chips.join("")}</div>` : ""}
      </header>
      <div class="quiz-player-stage-copy">
        <h2>${escapeHtml(title)}</h2>
        ${description ? `<p>${escapeHtml(description)}</p>` : ""}
      </div>
      ${body}
    </section>
  `;

  const getChoiceStatsAnimationKey = (snapshot) =>
    snapshot.status === "leaderboard" && snapshot.phaseMode === "chart"
      ? `${snapshot.sessionId || ""}:${snapshot.currentQuestion?.id || ""}:${snapshot.phaseEndsAt || ""}`
      : "";

  const shouldAnimateChoiceStats = (snapshot) => {
    const animationKey = getChoiceStatsAnimationKey(snapshot);
    return Boolean(animationKey) && animationKey !== animatedChoiceStatsKey;
  };

  const animateChoiceStats = (scope) => {
    const percentNodes = Array.from(scope.querySelectorAll("[data-choice-percent]"));
    const meterNodes = Array.from(scope.querySelectorAll("[data-choice-meter-fill]"));

    if (!percentNodes.length && !meterNodes.length) {
      return;
    }

    const clampPercent = (value) => Math.max(0, Math.min(100, Number(value) || 0));
    const finalize = () => {
      percentNodes.forEach((node) => {
        node.textContent = `${Math.round(clampPercent(node.dataset.targetPercent))}%`;
      });

      meterNodes.forEach((node) => {
        node.style.width = `${clampPercent(node.dataset.targetWidth)}%`;
      });
    };

    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      finalize();
      return;
    }

    const durationMs = 850;
    const startedAt = window.performance.now();
    const easeOutCubic = (value) => 1 - (1 - value) ** 3;

    const step = (now) => {
      const progress = Math.min(1, (now - startedAt) / durationMs);
      const easedProgress = easeOutCubic(progress);

      percentNodes.forEach((node) => {
        const target = clampPercent(node.dataset.targetPercent);
        node.textContent = `${Math.round(target * easedProgress)}%`;
      });

      meterNodes.forEach((node) => {
        const target = clampPercent(node.dataset.targetWidth);
        node.style.width = `${target * easedProgress}%`;
      });

      if (progress < 1) {
        window.requestAnimationFrame(step);
      } else {
        finalize();
      }
    };

    window.requestAnimationFrame(() => {
      meterNodes.forEach((node) => {
        node.style.width = "0%";
      });
      window.requestAnimationFrame(step);
    });
  };

  const resetSelectedChoicesForNewQuestion = (snapshot) => {
    const currentQuestionId = snapshot.currentQuestion?.id || null;

    if (snapshot.status === "question" && currentQuestionId !== lastRenderedQuestionId) {
      selectedChoiceIds = [];
      selectingChoiceIds = [];
    }

    if (currentQuestionId !== lastRenderedQuestionId) {
      lastRenderedQuestionId = currentQuestionId;
    }
  };

  const clearWrongAnswerPopupTimer = () => {
    if (wrongAnswerPopupTimer) {
      window.clearTimeout(wrongAnswerPopupTimer);
      wrongAnswerPopupTimer = null;
    }
  };

  const syncWrongAnswerPopupState = (snapshot) => {
    const isRevealChart = snapshot.status === "leaderboard" && snapshot.phaseMode === "chart";
    const currentQuestionId = snapshot.currentQuestion?.id || null;
    const shouldShowWrongAnswerPopup =
      isRevealChart &&
      Boolean(currentQuestionId) &&
      snapshot.participant?.lastAnswerCorrect === false &&
      Boolean(snapshot.participant?.selectedChoiceIds?.length);

    if (shouldShowWrongAnswerPopup) {
      if (wrongAnswerPopupQuestionId !== currentQuestionId) {
        wrongAnswerPopupQuestionId = currentQuestionId;
        wrongAnswerPopupVisible = true;
        clearWrongAnswerPopupTimer();
        wrongAnswerPopupTimer = window.setTimeout(() => {
          wrongAnswerPopupVisible = false;
          wrongAnswerPopupTimer = null;

          if (
            liveSnapshot.status === "leaderboard" &&
            liveSnapshot.phaseMode === "chart" &&
            liveSnapshot.currentQuestion?.id === currentQuestionId
          ) {
            render(liveSnapshot);
          }
        }, 2000);
      }

      return;
    }

    if (!isRevealChart) {
      clearWrongAnswerPopupTimer();
      wrongAnswerPopupVisible = false;
    }
  };

  const getVisibleSelectedChoiceIds = (snapshot, options = {}) => {
    if (options.selectedChoiceIds !== undefined) {
      return options.selectedChoiceIds;
    }

    const participantSelectedChoiceIds = snapshot.participant?.selectedChoiceIds || [];

    if (
      snapshot.status === "question" &&
      !snapshot.participant?.hasAnsweredCurrentQuestion &&
      selectedChoiceIds.length
    ) {
      return selectedChoiceIds;
    }

    if (participantSelectedChoiceIds.length) {
      return participantSelectedChoiceIds;
    }

    return selectedChoiceIds;
  };

  const triggerSelectionAnimation = (choiceId) => {
    selectingChoiceIds = Number.isInteger(choiceId) ? [choiceId] : [];
    render(liveSnapshot);

    if (!selectingChoiceIds.length) {
      return;
    }

    window.setTimeout(() => {
      if (selectingChoiceIds.includes(choiceId)) {
        selectingChoiceIds = [];
        render(liveSnapshot);
      }
    }, 260);
  };

  const renderLeaderboardRows = (snapshot, options = {}) => {
    const highlightPlayer = options.highlightPlayer !== false;
    const limit = options.limit || snapshot.leaderboard?.length || 0;

    if (!snapshot.leaderboard?.length) {
      return '<p class="quiz-live-muted">Waiting for leaderboard data.</p>';
    }

    return `
      <div class="quiz-live-leaderboard-list">
        ${snapshot.leaderboard
          .slice(0, limit)
          .map(
            (entry) => `
              <article class="quiz-live-leaderboard-row ${highlightPlayer && snapshot.participant?.id === entry.participantId ? "is-player" : ""}">
                <span class="quiz-live-leaderboard-rank">${entry.rank}</span>
                <strong>${escapeHtml(entry.displayName)}</strong>
                <span>${escapeHtml(entry.answerSummaryLabel)} correct</span>
                <span>${escapeHtml(entry.totalResponseTimeLabel)}</span>
              </article>
            `
          )
          .join("")}
      </div>
    `;
  };

  const getPlayerLeaderboardEntry = (snapshot) => {
    if (!snapshot.leaderboard?.length) {
      return null;
    }

    const participantId =
      snapshot.participant?.id === undefined || snapshot.participant?.id === null
        ? ""
        : String(snapshot.participant.id);
    const participantName = String(snapshot.participant?.displayName || initialPlayerName || "")
      .trim()
      .toLowerCase();

    if (participantId) {
      const matchedById = snapshot.leaderboard.find(
        (entry) => String(entry.participantId || "") === participantId
      );

      if (matchedById) {
        return matchedById;
      }
    }

    if (participantName) {
      return (
        snapshot.leaderboard.find(
          (entry) => String(entry.displayName || "").trim().toLowerCase() === participantName
        ) || null
      );
    }

    return null;
  };

  const getOrdinalSuffix = (value) => {
    const safeValue = Math.abs(Number(value) || 0);
    const lastTwoDigits = safeValue % 100;
    if (lastTwoDigits >= 11 && lastTwoDigits <= 13) {
      return "th";
    }

    switch (safeValue % 10) {
      case 1:
        return "st";
      case 2:
        return "nd";
      case 3:
        return "rd";
      default:
        return "th";
    }
  };

  const renderFinalPlace = (snapshot) => {
    const playerEntry = getPlayerLeaderboardEntry(snapshot);

    if (!playerEntry) {
      return `
        <section class="quiz-player-final-place is-pending">
          <span class="quiz-player-final-intro">You are in the</span>
          <div class="quiz-player-final-rank-wrap" aria-live="polite">
            <div class="quiz-player-final-rank">
              <span class="quiz-player-final-rank-number">--</span>
            </div>
            <span class="quiz-player-final-place-word">PLACE</span>
          </div>
          <p class="quiz-player-final-note">Final ranking is loading.</p>
        </section>
      `;
    }

    const rankNumber = Number(playerEntry.rank) || 0;
    const ordinalSuffix = getOrdinalSuffix(rankNumber);
    const placementLabel = `${rankNumber}${ordinalSuffix}`;
    const rankedCount = snapshot.leaderboard?.length || 0;

    return `
      <section class="quiz-player-final-place" aria-live="polite">
        <span class="quiz-player-final-intro">You are in the</span>
        <div class="quiz-player-final-rank-wrap">
          <div class="quiz-player-final-rank" aria-label="${placementLabel} place">
            <span class="quiz-player-final-rank-number">${rankNumber}</span>
            <span class="quiz-player-final-rank-suffix">${ordinalSuffix}</span>
          </div>
          <span class="quiz-player-final-place-word">PLACE</span>
        </div>
        <p class="quiz-player-final-note">
          ${escapeHtml(playerEntry.answerSummaryLabel)} correct out of ${snapshot.totalQuestions || 0}.
          Total time ${escapeHtml(playerEntry.totalResponseTimeLabel)} across ${rankedCount} players.
        </p>
      </section>
    `;
  };

  const renderWrongAnswerPopup = () => `
    <div class="quiz-player-reveal-popup" role="status" aria-live="polite">
      <div class="quiz-player-reveal-popup-card">
        <span class="quiz-player-reveal-popup-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M8 8 16 16"></path>
            <path d="m16 8-8 8"></path>
          </svg>
        </span>
        <strong>Wrong answer</strong>
        <p>The correct answer is shown below.</p>
      </div>
    </div>
  `;

  const renderChoiceGrid = (snapshot, options = {}) => {
    if (!snapshot.currentQuestion?.choices?.length) {
      return '<p class="quiz-live-muted">No answer options are available for this question.</p>';
    }

    const selectedIds = getVisibleSelectedChoiceIds(snapshot, options);

    return `
      <div class="quiz-live-choice-grid quiz-live-choice-grid-player">
        ${snapshot.currentQuestion.choices
          .map((choice, index) => {
            const isSelected = selectedIds.includes(choice.id);
            const toneClass = getChoiceTone(index);
            const classes = ["quiz-live-choice-card", toneClass];

            if (isSelected) {
              classes.push("is-selected");
            }

            if (selectingChoiceIds.includes(choice.id)) {
              classes.push("is-selecting");
            }

            if (options.muteUnselected && selectedIds.length && !isSelected) {
              classes.push("is-muted");
            }

            if (options.showAnswer && choice.isCorrect) {
              classes.push("is-correct", "is-reveal-correct");
            }

            if (options.showAnswer && !choice.isCorrect) {
              classes.push("is-wrong", "is-reveal-wrong");
            }

            if (options.showStats) {
              classes.push("has-stat");
            }

            const selectedPercent = Math.max(0, Math.min(100, Number(choice.selectedPercent) || 0));

            return `
              <button
                type="button"
                class="${classes.join(" ")}"
                data-player-choice="${choice.id}"
                ${options.disabled ? "disabled" : ""}
              >
                <div class="quiz-live-choice-copy">
                  <span class="quiz-player-choice-badge">${choiceLetters[index] || index + 1}</span>
                  <span class="quiz-live-choice-label">${escapeHtml(choice.label)}</span>
                  ${
                    options.showAnswer && choice.isCorrect
                      ? '<span class="quiz-live-choice-correct">Correct</span>'
                      : ""
                  }
                </div>
                ${
                  options.showStats
                    ? `
                      <div class="quiz-live-choice-stat">
                        <strong ${options.animateStats ? `data-choice-percent data-target-percent="${selectedPercent}"` : ""}>${options.animateStats ? "0%" : `${selectedPercent}%`}</strong>
                        <span>${choice.selectedCount} players</span>
                        <div class="quiz-live-choice-meter">
                          <span ${options.animateStats ? `data-choice-meter-fill data-target-width="${selectedPercent}" style="width:0%"` : `style="width:${selectedPercent}%"`}></span>
                        </div>
                      </div>
                    `
                    : ""
                }
              </button>
            `;
          })
          .join("")}
      </div>
    `;
  };

  const renderQuestionMedia = (snapshot) => {
    if (!snapshot.currentQuestion?.imageUrl) {
      return "";
    }

    return `
      <figure class="quiz-live-question-media">
        <img src="${escapeHtml(snapshot.currentQuestion.imageUrl)}" alt="Question reference image" />
      </figure>
    `;
  };

  const renderQuestionStage = (snapshot) => {
    const timeLeft = snapshot.phaseEndsAt
      ? new Date(snapshot.phaseEndsAt).getTime() - Date.now()
      : 0;
    const hasPendingSingleChoiceSelection =
      snapshot.currentQuestion?.questionType !== "multiple_choice" && selectedChoiceIds.length > 0;

    if (snapshot.participant?.hasAnsweredCurrentQuestion) {
      return renderStageShell({
        iconName: "check",
        label: "Answer Locked",
        title: snapshot.currentQuestion?.prompt || "Untitled question",
        description: "",
        chips: [
          renderMetaChip("clock", "Time left", formatCountdown(snapshot.phaseEndsAt), "quiz-player-stage-meta-chip-countdown", "data-player-countdown"),
          renderMetaChip("users", "In room", String(snapshot.participantCount || 0))
        ],
        body: `
          ${renderQuestionTimebar(snapshot)}
          ${renderQuestionMedia(snapshot)}
          ${renderChoiceGrid(snapshot, {
            selectedChoiceIds: snapshot.participant?.selectedChoiceIds || [],
            disabled: true,
            muteUnselected: true
          })}
        `,
        stageClass: "quiz-player-stage-question"
      });
    }

    if (timeLeft <= 0) {
      return renderStageShell({
        iconName: "clock",
        label: "Time Up",
        title: snapshot.currentQuestion?.prompt || "Untitled question",
        description: "",
        chips: [
          renderMetaChip("clock", "Timer", "0s", "quiz-player-stage-meta-chip-countdown"),
          renderMetaChip("users", "In room", String(snapshot.participantCount || 0))
        ],
        body: `${renderQuestionMedia(snapshot)}`,
        stageClass: "quiz-player-stage-question"
      });
    }

    return renderStageShell({
      iconName: "pulse",
      label: `Question ${snapshot.currentQuestion?.position || 1} / ${snapshot.totalQuestions}`,
      title: snapshot.currentQuestion?.prompt || "Untitled question",
      description: "",
      chips: [
        renderMetaChip("clock", "Time left", formatCountdown(snapshot.phaseEndsAt), "quiz-player-stage-meta-chip-countdown", "data-player-countdown"),
        renderMetaChip("users", "In room", String(snapshot.participantCount || 0))
      ],
      body: `
        ${renderQuestionTimebar(snapshot)}
        ${renderQuestionMedia(snapshot)}
        ${renderChoiceGrid(snapshot, {
          disabled: actionPending,
          muteUnselected: hasPendingSingleChoiceSelection
        })}
        ${
          snapshot.currentQuestion?.questionType === "multiple_choice"
            ? `
              <div class="quiz-player-stage-actions">
                <button
                  type="button"
                  class="primary-button"
                  data-player-submit
                  ${selectedChoiceIds.length ? "" : "disabled"}
                >
                  Submit Answer
                </button>
              </div>
            `
            : ""
        }
      `,
      stageClass: "quiz-player-stage-question"
    });
  };

  const renderChartStage = (snapshot, options = {}) =>
    renderStageShell({
      iconName: "chart",
      label: "Answer Breakdown",
      title: snapshot.currentQuestion?.prompt || "Untitled question",
      description: "",
      chips: [
        renderMetaChip("clock", "Next reveal", formatCountdown(snapshot.phaseEndsAt), "quiz-player-stage-meta-chip-countdown", "data-player-countdown"),
        renderMetaChip("users", "Answered", `${snapshot.answeredCount || 0} / ${snapshot.participantCount || 0}`)
      ],
      body: `
        <div class="quiz-player-reveal-shell ${wrongAnswerPopupVisible ? "has-popup" : ""}">
          ${wrongAnswerPopupVisible ? renderWrongAnswerPopup() : ""}
          ${renderQuestionMedia(snapshot)}
          ${renderChoiceGrid(snapshot, {
            selectedChoiceIds: snapshot.participant?.selectedChoiceIds || [],
            disabled: true,
            muteUnselected: true,
            showAnswer: true,
            showStats: true,
            animateStats: options.animateStats
          })}
        </div>
      `,
      stageClass: "quiz-player-stage-chart"
    });

  const renderLeaderboardStage = (snapshot) =>
    renderStageShell({
      iconName: "trophy",
      label: "Leaderboard",
      title: "Current rankings",
      description: "",
      chips: [
        renderMetaChip("clock", "Next question", formatCountdown(snapshot.phaseEndsAt), "quiz-player-stage-meta-chip-countdown", "data-player-countdown"),
        renderMetaChip("users", "Players ranked", String(snapshot.leaderboard?.length || 0))
      ],
      body: renderLeaderboardRows(snapshot, { limit: 10 }),
      stageClass: "quiz-player-stage-leaderboard"
    });

  const renderCountdownStage = (snapshot) => {
    const nextQuestionPosition = snapshot.nextQuestionPosition || snapshot.currentQuestionIndex + 2;
    const countdownLabel = nextQuestionPosition === 1 ? "First Question" : "Next Question";

    return renderStageShell({
      iconName: "spark",
      label: countdownLabel,
      title: `Question ${nextQuestionPosition} starts in`,
      description: "",
      body: `
        <div class="quiz-player-stage-countdown-shell">
          <div class="quiz-player-stage-countdown-orbit">
            <div class="quiz-live-big-countdown" data-player-big-countdown>${formatCountdownNumber(snapshot.phaseEndsAt)}</div>
          </div>
        </div>
      `,
      stageClass: "quiz-live-countdown-stage quiz-player-stage-centered"
    });
  };

  const renderLobbyWaitingStage = (snapshot) => `
    <section class="quiz-player-waiting-shell">
      <div class="quiz-player-waiting-topline">
        <span class="quiz-player-waiting-topicon" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M8 21h8"></path>
            <path d="M12 17v4"></path>
            <path d="M7 4h10v4a5 5 0 0 1-10 0Z"></path>
            <path d="M17 6h2a2 2 0 0 1 0 4h-2"></path>
            <path d="M7 6H5a2 2 0 1 0 0 4h2"></path>
          </svg>
        </span>
        <span>Quiz</span>
      </div>

      <section class="quiz-player-waiting-card">
        <div class="quiz-player-waiting-check" aria-hidden="true">
          <span class="quiz-player-waiting-check-ring quiz-player-waiting-check-ring-a"></span>
          <span class="quiz-player-waiting-check-ring quiz-player-waiting-check-ring-b"></span>
          <span class="quiz-player-waiting-check-icon">
            <svg viewBox="0 0 24 24">
              <path d="m5 13 4 4L19 7"></path>
            </svg>
          </span>
        </div>

        <div class="quiz-player-waiting-copy">
          <h2>Get ready, ${escapeHtml(initialPlayerName)}!</h2>
          <p>${escapeHtml(formatJoinedParticipants(snapshot.participantCount || 0))}</p>
        </div>
      </section>
    </section>
  `;

  const render = (snapshot) => {
    if (audioController) {
      audioController.sync(snapshot);
    }

    resetSelectedChoicesForNewQuestion(snapshot);
    syncWrongAnswerPopupState(snapshot);
    const isChartStage = snapshot.status === "leaderboard" && snapshot.phaseMode === "chart";
    const shouldAnimateStats = isChartStage && shouldAnimateChoiceStats(snapshot);

    if (!isChartStage) {
      animatedChoiceStatsKey = "";
    }

    let stageMarkup = "";

    if (snapshot.status === "lobby") {
      quizLivePlayerShell.innerHTML = renderLobbyWaitingStage(snapshot);
      return;
    } else if (snapshot.status === "question") {
      stageMarkup = renderQuestionStage(snapshot);
    } else if (isChartStage) {
      stageMarkup = renderChartStage(snapshot, { animateStats: shouldAnimateStats });
    } else if (snapshot.status === "leaderboard" && snapshot.phaseMode === "leaderboard") {
      stageMarkup = renderLeaderboardStage(snapshot);
    } else if (snapshot.status === "leaderboard" && snapshot.phaseMode === "countdown") {
      stageMarkup = renderCountdownStage(snapshot);
    } else {
      stageMarkup = renderStageShell({
        iconName: "crown",
        label: "Quiz Ended",
        title: "Your final result",
        description: "",
        body: renderFinalPlace(snapshot),
        stageClass: "quiz-player-stage-ended quiz-player-stage-centered"
      });
    }

    quizLivePlayerShell.innerHTML = `
      <div class="quiz-player-live-flow">
        <div class="quiz-player-identity">
          <span>Playing as</span>
          <strong>${escapeHtml(initialPlayerName)}</strong>
        </div>
        ${stageMarkup}
      </div>
    `;

    if (shouldAnimateStats) {
      animateChoiceStats(quizLivePlayerShell);
      animatedChoiceStatsKey = getChoiceStatsAnimationKey(snapshot);
    }
  };

  const loadState = async () => {
    const response = await fetch(stateUrl, {
      headers: {
        Accept: "application/json"
      }
    });

    if (!response.ok) {
      throw new Error("Unable to refresh the live quiz.");
    }

    const payload = await response.json();
    if (payload.snapshot) {
      liveSnapshot = payload.snapshot;
      boundarySyncKey = "";
      render(liveSnapshot);
    }
  };

  const submitAnswer = async (choiceIds) => {
    if (!choiceIds.length || actionPending) {
      return;
    }

    actionPending = true;

    try {
      const response = await fetch(answerUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify({ choiceIds })
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Unable to submit the answer.");
      }

      if (payload.snapshot) {
        liveSnapshot = payload.snapshot;
        boundarySyncKey = "";
        render(liveSnapshot);
      }
    } catch (error) {
      window.alert(error.message);
    } finally {
      actionPending = false;
    }
  };

  quizLivePlayerShell.addEventListener("click", (event) => {
    const choiceButton = event.target.closest("[data-player-choice]");

    if (
      choiceButton &&
      liveSnapshot.status === "question" &&
      !liveSnapshot.participant?.hasAnsweredCurrentQuestion &&
      !actionPending
    ) {
      const choiceId = Number.parseInt(choiceButton.dataset.playerChoice, 10);

      if (!Number.isInteger(choiceId)) {
        return;
      }

      if (liveSnapshot.currentQuestion?.questionType === "multiple_choice") {
        selectedChoiceIds = selectedChoiceIds.includes(choiceId)
          ? selectedChoiceIds.filter((item) => item !== choiceId)
          : [...selectedChoiceIds, choiceId].sort((left, right) => left - right);
        triggerSelectionAnimation(choiceId);
      } else {
        selectedChoiceIds = [choiceId];
        triggerSelectionAnimation(choiceId);
        render(liveSnapshot);
        submitAnswer(selectedChoiceIds);
      }
      return;
    }

    const submitButton = event.target.closest("[data-player-submit]");
    if (submitButton && !actionPending) {
      submitAnswer(selectedChoiceIds);
    }
  });

  render(liveSnapshot);
  window.setInterval(() => {
    loadState().catch(() => {});
  }, 1000);
  window.setInterval(() => {
    const countdown = quizLivePlayerShell.querySelector("[data-player-countdown]");
    if (countdown) {
      countdown.textContent = formatCountdown(liveSnapshot.phaseEndsAt);
    }

    const bigCountdown = quizLivePlayerShell.querySelector("[data-player-big-countdown]");
    if (bigCountdown) {
      bigCountdown.textContent = formatCountdownNumber(liveSnapshot.phaseEndsAt);
    }

    quizLivePlayerShell.querySelectorAll("[data-player-timebar-fill]").forEach((node) => {
      const progress = getQuestionTimebarProgress(liveSnapshot);
      const progressPercent = Math.max(0, Math.min(100, progress * 100));
      const timebar = node.closest(".quiz-player-timebar");

      node.style.width = `${progressPercent}%`;

      if (timebar) {
        timebar.classList.toggle("is-warning", progress <= 0.45 && progress > 0.22);
        timebar.classList.toggle("is-danger", progress <= 0.22);
      }
    });

    if (liveSnapshot.phaseEndsAt) {
      const phaseDeadline = new Date(liveSnapshot.phaseEndsAt).getTime();
      const currentBoundaryKey = getCurrentBoundaryKey(liveSnapshot);

      if (Date.now() >= phaseDeadline && currentBoundaryKey && boundarySyncKey !== currentBoundaryKey) {
        boundarySyncKey = currentBoundaryKey;
        loadState().catch(() => {});
      }
    }
  }, 250);
}
