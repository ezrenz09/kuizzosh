const quizLiveHostShell = document.querySelector("[data-quiz-live-host]");
const quizLiveHostDataScript = document.querySelector("[data-quiz-live-host-data]");

if (quizLiveHostShell && quizLiveHostDataScript) {
  const stateUrl = quizLiveHostShell.dataset.stateUrl || "";
  const advanceUrl = quizLiveHostShell.dataset.advanceUrl || "";
  const endUrl = quizLiveHostShell.dataset.endUrl || "";
  const restartUrl = quizLiveHostShell.dataset.restartUrl || "";
  let liveSnapshot = {};
  let actionPending = false;
  let boundarySyncKey = "";
  let animatedChoiceStatsKey = "";
  const hostIcons = {
    spark:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8Z"></path></svg>',
    users:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="3"></circle><path d="M22 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>',
    link:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.07 0l2.12-2.12a5 5 0 0 0-7.07-7.07L10.7 5.22"></path><path d="M14 11a5 5 0 0 0-7.07 0L4.81 13.12a5 5 0 1 0 7.07 7.07L13.3 18.8"></path></svg>',
    qr:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h6v6H4z"></path><path d="M14 4h6v6h-6z"></path><path d="M4 14h6v6H4z"></path><path d="M15 15h1"></path><path d="M18 15h2"></path><path d="M15 18h5"></path><path d="M18 14v6"></path></svg>',
    screen:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"></rect><path d="M8 20h8"></path><path d="M12 16v4"></path></svg>',
    chart:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20V10"></path><path d="M10 20V4"></path><path d="M16 20v-7"></path><path d="M22 20v-3"></path></svg>',
    trophy:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 21h8"></path><path d="M12 17v4"></path><path d="M7 4h10v4a5 5 0 0 1-10 0Z"></path><path d="M17 6h2a2 2 0 0 1 0 4h-2"></path><path d="M7 6H5a2 2 0 1 0 0 4h2"></path></svg>',
    target:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"></circle><circle cx="12" cy="12" r="3"></circle><path d="M12 2v2"></path><path d="M12 20v2"></path><path d="m4.93 4.93 1.41 1.41"></path><path d="m17.66 17.66 1.41 1.41"></path></svg>',
    crown:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 8 5 4 4-6 4 6 5-4-2 10H5Z"></path><path d="M5 18h14"></path></svg>',
    pulse:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h4l2-5 4 10 2-5h6"></path></svg>',
    clock:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 3"></path></svg>'
  };
  const choiceLetters = ["A", "B", "C", "D", "E", "F"];

  try {
    liveSnapshot = JSON.parse(quizLiveHostDataScript.textContent || "{}");
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

  const getCurrentBoundaryKey = (snapshot) =>
    `${snapshot.status || ""}:${snapshot.phaseMode || ""}:${snapshot.phaseEndsAt || ""}`;

  const renderIcon = (iconName) => hostIcons[iconName] || hostIcons.spark;

  const renderMetaChip = (iconName, label, value, extraClass = "", valueAttributes = "") => `
    <div class="quiz-live-host-meta-chip ${extraClass}">
      <span class="quiz-live-host-meta-icon" aria-hidden="true">${renderIcon(iconName)}</span>
      <span class="quiz-live-host-meta-copy">
        <span>${escapeHtml(label)}</span>
        <strong ${valueAttributes}>${escapeHtml(value)}</strong>
      </span>
    </div>
  `;

  const renderInlineFact = (iconName, label, value) => `
    <div class="quiz-live-host-fact">
      <span class="quiz-live-host-fact-icon" aria-hidden="true">${renderIcon(iconName)}</span>
      <div class="quiz-live-host-fact-copy">
        <strong>${escapeHtml(label)}</strong>
        <span>${escapeHtml(value)}</span>
      </div>
    </div>
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

  const renderParticipantCloud = (snapshot) => {
    if (!snapshot.participants?.length) {
      return '<p class="quiz-live-host-empty-note">No players joined yet. Share the code on the present screen to fill the room.</p>';
    }

    const visibleParticipants = snapshot.participants.slice(0, 18);
    const hiddenCount = Math.max(0, snapshot.participants.length - visibleParticipants.length);

    return `
      <div class="quiz-live-host-player-cloud">
        ${visibleParticipants
          .map(
            (participant) => `
              <span class="quiz-live-host-player-pill">${escapeHtml(participant.displayName)}</span>
            `
          )
          .join("")}
        ${hiddenCount ? `<span class="quiz-live-host-player-more">+${hiddenCount} more</span>` : ""}
      </div>
    `;
  };

  const renderChoiceChart = (snapshot, options = {}) => {
    if (!snapshot.currentQuestion?.choices?.length) {
      return "";
    }

    const choiceColors = ["choice-red", "choice-blue", "choice-yellow", "choice-green"];

    return `
      <div class="quiz-live-choice-grid quiz-live-choice-grid-host">
        ${snapshot.currentQuestion.choices
          .map((choice, index) => {
            const selectedPercent = Math.max(0, Math.min(100, Number(choice.selectedPercent) || 0));

            return `
            <div class="quiz-live-choice-card ${choiceColors[index % choiceColors.length]} has-stat ${choice.isCorrect ? "is-correct is-reveal-correct" : "is-wrong is-reveal-wrong"}">
              <div class="quiz-live-choice-copy">
                <span class="quiz-live-host-choice-badge">${choiceLetters[index] || index + 1}</span>
                <span class="quiz-live-choice-label">${escapeHtml(choice.label)}</span>
                ${choice.isCorrect ? '<span class="quiz-live-choice-correct">Correct answer</span>' : ""}
              </div>
              <div class="quiz-live-choice-stat">
                <strong ${options.animateStats ? `data-choice-percent data-target-percent="${selectedPercent}"` : ""}>${options.animateStats ? "0%" : `${selectedPercent}%`}</strong>
                <span>${choice.selectedCount} players</span>
                <div class="quiz-live-choice-meter">
                  <span ${options.animateStats ? `data-choice-meter-fill data-target-width="${selectedPercent}" style="width:0%"` : `style="width:${selectedPercent}%"`}></span>
                </div>
              </div>
            </div>
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

  const renderQuestionChoices = (snapshot) => {
    if (!snapshot.currentQuestion?.choices?.length) {
      return "";
    }

    const choiceColors = ["choice-red", "choice-blue", "choice-yellow", "choice-green"];

    return `
      <div class="quiz-live-choice-grid quiz-live-choice-grid-host">
        ${snapshot.currentQuestion.choices
          .map((choice, index) => `
            <div class="quiz-live-choice-card ${choiceColors[index % choiceColors.length]}">
              <div class="quiz-live-choice-copy">
                <span class="quiz-live-host-choice-badge">${choiceLetters[index] || index + 1}</span>
                <span class="quiz-live-choice-label">${escapeHtml(choice.label)}</span>
              </div>
            </div>
          `)
          .join("")}
      </div>
    `;
  };

  const renderLeaderboardRows = (snapshot, options = {}) => {
    const limit = options.limit || snapshot.leaderboard?.length || 0;

    if (!snapshot.leaderboard?.length) {
      return '<p class="quiz-live-host-empty-note">Leaderboard will appear once players answer.</p>';
    }

    return `
      <div class="quiz-live-leaderboard-list">
        ${snapshot.leaderboard
          .slice(0, limit)
          .map(
            (entry) => `
              <article class="quiz-live-leaderboard-row">
                <span class="quiz-live-leaderboard-rank">${entry.rank}</span>
                <div class="quiz-live-host-leaderboard-person">
                  <strong>${escapeHtml(entry.displayName)}</strong>
                  <span>${escapeHtml(entry.answerSummaryLabel)} correct</span>
                </div>
                <span class="quiz-live-host-leaderboard-time">${escapeHtml(entry.totalResponseTimeLabel)}</span>
              </article>
            `
          )
          .join("")}
      </div>
    `;
  };

  const renderFinalLeaderboard = (snapshot) => {
    if (!snapshot.leaderboard?.length) {
      return '<p class="quiz-live-host-empty-note">Waiting for final standings.</p>';
    }

    const podiumEntries = snapshot.leaderboard.slice(0, 3);
    const remainingEntries = snapshot.leaderboard.slice(3);

    return `
      <div class="quiz-live-final-board">
        <div class="quiz-live-final-podium">
          ${podiumEntries
            .map(
              (entry) => `
                <article class="quiz-live-podium-card quiz-live-podium-card-${entry.rank}">
                  <span class="quiz-live-podium-rank">#${entry.rank}</span>
                  <strong>${escapeHtml(entry.displayName)}</strong>
                  <span>${escapeHtml(entry.answerSummaryLabel)} correct</span>
                  <span>${escapeHtml(entry.totalResponseTimeLabel)}</span>
                </article>
              `
            )
            .join("")}
        </div>
        ${
          remainingEntries.length
            ? `
              <div class="quiz-live-final-list">
                ${renderLeaderboardRows(
                  {
                    ...snapshot,
                    leaderboard: remainingEntries
                  },
                  { limit: remainingEntries.length }
                )}
              </div>
            `
            : ""
        }
      </div>
    `;
  };

  const renderActionButtons = (snapshot) => {
    if (snapshot.status === "lobby") {
      return `
        <button type="button" class="primary-button" data-live-start ${actionPending ? "disabled" : ""}>
          Start Quiz
        </button>
        <button type="button" class="secondary-button" data-live-end ${actionPending ? "disabled" : ""}>
          End Quiz
        </button>
      `;
    }

    if (snapshot.status === "ended") {
      return `
        <a href="${restartUrl}?new=1" class="primary-button">Play Again</a>
        <a href="/quizzes/${snapshot.quiz?.id || ""}/setup" class="secondary-button">Back to Setup</a>
      `;
    }

    return `
      <a href="${escapeHtml(snapshot.quiz?.presentUrl || "#")}" class="secondary-button" target="_blank" rel="noreferrer">Present Mode</a>
      <button type="button" class="secondary-button" data-live-end ${actionPending ? "disabled" : ""}>
        End Quiz
      </button>
    `;
  };

  const renderStageActions = (snapshot) => `
    <div class="quiz-live-stage-actions">
      ${renderActionButtons(snapshot)}
    </div>
  `;

  const renderHostSupport = (snapshot) => `
    <section class="quiz-live-host-support">
      <div class="quiz-live-host-support-head">
        <div>
          <span class="section-pill">Host Control</span>
          <span class="quiz-live-host-support-hint">Everything stays on one screen while you manage the room.</span>
        </div>
      </div>
      <div class="quiz-live-host-fact-grid">
        ${renderInlineFact("target", "Room code", snapshot.quiz?.quizCode || "")}
        ${renderInlineFact("users", "Players live", `${snapshot.participantCount || 0} joined right now`)}
        ${renderInlineFact(
          "screen",
          "Presenter screen",
          snapshot.status === "ended"
            ? "The public screen can stay on the final leaderboard."
            : "Keep the public screen open so everyone can follow the quiz flow."
        )}
      </div>
      <div class="quiz-live-host-support-actions">
        ${renderActionButtons(snapshot)}
      </div>
      <div class="quiz-live-host-participant-band">
        <div class="quiz-live-host-participant-head">
          <strong>Joined players</strong>
          <span>${snapshot.participantCount || 0} in room</span>
        </div>
        ${renderParticipantCloud(snapshot)}
      </div>
    </section>
  `;

  const renderHostStage = ({ iconName, label, title, description, chips = [], body = "", stageClass = "" }, snapshot) => `
    <section class="quiz-live-host-runtime ${stageClass}">
      <header class="quiz-live-host-runtime-head">
        <div class="quiz-live-host-brandline">
          <span class="quiz-live-host-icon-badge" aria-hidden="true">${renderIcon(iconName)}</span>
          <div class="quiz-live-host-brand-copy">
            <span class="section-pill">${escapeHtml(label)}</span>
            <span class="quiz-live-host-brand-hint">Host console</span>
          </div>
        </div>
        ${chips.length ? `<div class="quiz-live-host-meta-row">${chips.join("")}</div>` : ""}
      </header>
      <div class="quiz-live-host-headline">
        <h2>${escapeHtml(title)}</h2>
        ${description ? `<p>${escapeHtml(description)}</p>` : ""}
      </div>
      <div class="quiz-live-host-focus">
        ${body}
      </div>
      ${renderHostSupport(snapshot)}
    </section>
  `;

  const renderLobbyStage = (snapshot) => {
    const joinLink = `${window.location.origin}${snapshot.quiz?.joinUrl || ""}`;
    const presentLink = `${window.location.origin}${snapshot.quiz?.presentUrl || ""}`;
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=${encodeURIComponent(joinLink)}`;
    const participantsMarkup = snapshot.participants?.length
      ? `
          <div class="quiz-live-host-lobby-player-strip">
            ${snapshot.participants
              .map(
                (participant) => `
                  <span class="quiz-live-host-lobby-player-pill">${escapeHtml(participant.displayName)}</span>
                `
              )
              .join("")}
          </div>
        `
      : '<p class="quiz-live-host-lobby-empty">No players joined yet. Share the code or QR to get the room moving.</p>';

    return `
      <section class="quiz-live-stage-card quiz-live-stage-card-lobby">
        <div class="quiz-live-host-lobby-shell">
          <div class="quiz-live-host-lobby-topline">
            <div class="quiz-live-host-lobby-brand">
              <span class="quiz-live-host-lobby-icon" aria-hidden="true">${renderIcon("spark")}</span>
              <div class="quiz-live-host-lobby-brand-copy">
                <span class="section-pill">Live Quiz Lobby</span>
                <span class="quiz-live-host-lobby-kicker">Presenter-style join screen</span>
              </div>
            </div>

            <div class="quiz-live-host-lobby-chip-row">
              <div class="quiz-live-host-lobby-chip">
                <span class="quiz-live-host-lobby-chip-icon" aria-hidden="true">${renderIcon("users")}</span>
                <div class="quiz-live-host-lobby-chip-copy">
                  <span>Players ready</span>
                  <strong>${snapshot.participantCount || 0}</strong>
                </div>
              </div>
              <div class="quiz-live-host-lobby-chip">
                <span class="quiz-live-host-lobby-chip-icon" aria-hidden="true">${renderIcon("screen")}</span>
                <div class="quiz-live-host-lobby-chip-copy">
                  <span>Room code</span>
                  <strong>${escapeHtml(snapshot.quiz?.quizCode || "")}</strong>
                </div>
              </div>
            </div>
          </div>

          <div class="quiz-live-host-lobby-headline">
            <h2>${escapeHtml(snapshot.quiz?.title || "Live quiz room")}</h2>
            <p>Use the same join flow as the present page. Players can scan the QR, open the join link, or enter the room code on their phone.</p>
          </div>

          <div class="quiz-live-host-lobby-grid">
            <div class="quiz-live-host-lobby-flow">
              <div class="quiz-live-host-lobby-code-stack">
                <span class="quiz-live-host-lobby-code-label">Enter this code</span>
                <strong class="quiz-live-host-lobby-code">${escapeHtml(snapshot.quiz?.quizCode || "")}</strong>
              </div>

              <div class="quiz-live-host-lobby-facts">
                <div class="quiz-live-host-lobby-fact">
                  <span class="quiz-live-host-lobby-fact-icon" aria-hidden="true">${renderIcon("link")}</span>
                  <div class="quiz-live-host-lobby-fact-copy">
                    <strong>Join link</strong>
                    <span>${escapeHtml(joinLink)}</span>
                  </div>
                </div>

                <div class="quiz-live-host-lobby-fact">
                  <span class="quiz-live-host-lobby-fact-icon" aria-hidden="true">${renderIcon("screen")}</span>
                  <div class="quiz-live-host-lobby-fact-copy">
                    <strong>Present mode</strong>
                    <span>${escapeHtml(presentLink)}</span>
                  </div>
                </div>
              </div>

              <div class="quiz-live-host-lobby-player-zone">
                <div class="quiz-live-host-lobby-player-head">
                  <strong>Joined players</strong>
                  <span>${snapshot.participantCount || 0} in room</span>
                </div>
                ${participantsMarkup}
              </div>

              <div class="quiz-live-host-lobby-actions">
                <a href="${escapeHtml(snapshot.quiz?.presentUrl || "#")}" class="secondary-button" target="_blank" rel="noreferrer">Open Present Mode</a>
                <button type="button" class="primary-button" data-live-start ${actionPending ? "disabled" : ""}>Start Quiz</button>
                <button type="button" class="secondary-button" data-live-end ${actionPending ? "disabled" : ""}>End Quiz</button>
              </div>
            </div>

            <div class="quiz-live-host-lobby-qr">
              <div class="quiz-live-host-lobby-qr-frame">
                <img src="${qrUrl}" alt="Quiz join QR code" />
              </div>
              <div class="quiz-live-host-lobby-qr-copy">
                <span class="quiz-live-host-lobby-qr-icon" aria-hidden="true">${renderIcon("qr")}</span>
                <span>Scan to join instantly</span>
              </div>
            </div>
          </div>
        </div>
      </section>
    `;
  };

  const renderRuntimeStage = (snapshot) => {
    if (snapshot.status === "question") {
      return renderHostStage(
        {
          iconName: "pulse",
          label: `Question ${snapshot.currentQuestion?.position || 1} of ${snapshot.totalQuestions || 1}`,
          title: snapshot.currentQuestion?.prompt || "Untitled question",
          description: "",
          chips: [
            renderMetaChip("users", "Answered", `${snapshot.answeredCount || 0} / ${snapshot.participantCount || 0}`),
            renderMetaChip("clock", "Time left", formatCountdown(snapshot.phaseEndsAt), "quiz-live-host-meta-chip-countdown", "data-live-countdown"),
            renderMetaChip("target", "Room code", snapshot.quiz?.quizCode || "")
          ],
          body: `
            ${renderQuestionMedia(snapshot)}
            ${renderQuestionChoices(snapshot)}
          `,
          stageClass: "quiz-live-host-runtime-question"
        },
        snapshot
      );
    }

    if (snapshot.status === "leaderboard" && snapshot.phaseMode === "chart") {
      const shouldAnimateStats = shouldAnimateChoiceStats(snapshot);

      return renderHostStage(
        {
          iconName: "chart",
          label: "Answer Breakdown",
          title: snapshot.currentQuestion?.prompt || "Untitled question",
          description: "",
          chips: [
            renderMetaChip("chart", "Participation", `${snapshot.answeredPercentage || 0}% answered`),
            renderMetaChip("clock", "Next reveal", formatCountdown(snapshot.phaseEndsAt), "quiz-live-host-meta-chip-countdown", "data-live-countdown"),
            renderMetaChip("users", "Players", String(snapshot.participantCount || 0))
          ],
          body: `
            ${renderQuestionMedia(snapshot)}
            ${renderChoiceChart(snapshot, { animateStats: shouldAnimateStats })}
          `,
          stageClass: "quiz-live-host-runtime-chart"
        },
        snapshot
      );
    }

    if (snapshot.status === "leaderboard" && snapshot.phaseMode === "leaderboard") {
      return renderHostStage(
        {
          iconName: "trophy",
          label: "Leaderboard",
          title: "Current rankings",
          description: "",
          chips: [
            renderMetaChip("trophy", "Players ranked", String(snapshot.leaderboard?.length || 0)),
            renderMetaChip("clock", "Next question", formatCountdown(snapshot.phaseEndsAt), "quiz-live-host-meta-chip-countdown", "data-live-countdown"),
            renderMetaChip("target", "Room code", snapshot.quiz?.quizCode || "")
          ],
          body: renderLeaderboardRows(snapshot, { limit: 10 }),
          stageClass: "quiz-live-host-runtime-leaderboard"
        },
        snapshot
      );
    }

    if (snapshot.status === "leaderboard" && snapshot.phaseMode === "countdown") {
      const nextQuestionPosition = snapshot.nextQuestionPosition || (snapshot.currentQuestionIndex || 0) + 2;
      const countdownLabel = nextQuestionPosition === 1 ? "First Question" : "Next Question";

      return renderHostStage(
        {
          iconName: "spark",
          label: countdownLabel,
          title: `Question ${nextQuestionPosition} starts in`,
          description: "",
          chips: [
            renderMetaChip("clock", "Countdown", formatCountdown(snapshot.phaseEndsAt), "quiz-live-host-meta-chip-countdown", "data-live-countdown"),
            renderMetaChip("pulse", "Up next", `Question ${nextQuestionPosition}`),
            renderMetaChip("users", "Players live", String(snapshot.participantCount || 0))
          ],
          body: `
            <div class="quiz-live-host-countdown-shell">
              <div class="quiz-live-host-countdown-orbit">
                <div class="quiz-live-big-countdown" data-live-big-countdown>${formatCountdownNumber(snapshot.phaseEndsAt)}</div>
              </div>
            </div>
          `,
          stageClass: "quiz-live-host-runtime-countdown quiz-live-countdown-stage"
        },
        snapshot
      );
    }

    return renderHostStage(
      {
        iconName: "crown",
        label: "Quiz Finished",
        title: "Final standings",
        description: "",
        chips: [
          renderMetaChip("crown", "Winners shown", String(Math.min(3, snapshot.leaderboard?.length || 0))),
          renderMetaChip("users", "Total ranked", String(snapshot.leaderboard?.length || 0))
        ],
        body: renderFinalLeaderboard(snapshot),
        stageClass: "quiz-live-host-runtime-ended"
      },
      snapshot
    );
  };

  const render = (snapshot) => {
    const isChartStage = snapshot.status === "leaderboard" && snapshot.phaseMode === "chart";
    if (!isChartStage) {
      animatedChoiceStatsKey = "";
    }

    if (snapshot.status === "lobby") {
      quizLiveHostShell.innerHTML = `
        <section class="quiz-live-host-lobby-layout">
          ${renderLobbyStage(snapshot)}
        </section>
      `;
      return;
    }

    quizLiveHostShell.innerHTML = renderRuntimeStage(snapshot);

    if (isChartStage && shouldAnimateChoiceStats(snapshot)) {
      animateChoiceStats(quizLiveHostShell);
      animatedChoiceStatsKey = getChoiceStatsAnimationKey(snapshot);
    }
  };

  const loadState = async () => {
    if (!stateUrl) {
      return;
    }

    const response = await fetch(stateUrl, {
      headers: {
        Accept: "application/json"
      }
    });

    if (!response.ok) {
      throw new Error("Unable to refresh live state.");
    }

    const payload = await response.json();
    liveSnapshot = payload.snapshot || {};
    boundarySyncKey = "";
    render(liveSnapshot);
  };

  const postAction = async (url) => {
    if (!url || actionPending) {
      return;
    }

    actionPending = true;
    render(liveSnapshot);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Accept: "application/json"
        }
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "Unable to update the live quiz.");
      }

      liveSnapshot = payload.snapshot || liveSnapshot;
      boundarySyncKey = "";
    } catch (error) {
      window.alert(error.message);
    } finally {
      actionPending = false;
      render(liveSnapshot);
    }
  };

  quizLiveHostShell.addEventListener("click", (event) => {
    const startButton = event.target.closest("[data-live-start]");
    if (startButton) {
      postAction(advanceUrl);
      return;
    }

    const endButton = event.target.closest("[data-live-end]");
    if (endButton) {
      const shouldEnd = window.confirm("End this live quiz for everyone?");
      if (shouldEnd) {
        postAction(endUrl);
      }
    }
  });

  render(liveSnapshot);
  window.setInterval(() => {
    loadState().catch(() => {});
  }, 1000);
  window.setInterval(() => {
    const countdown = quizLiveHostShell.querySelector("[data-live-countdown]");
    if (countdown) {
      countdown.textContent = formatCountdown(liveSnapshot.phaseEndsAt);
    }

    const bigCountdown = quizLiveHostShell.querySelector("[data-live-big-countdown]");
    if (bigCountdown) {
      bigCountdown.textContent = formatCountdownNumber(liveSnapshot.phaseEndsAt);
    }

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
