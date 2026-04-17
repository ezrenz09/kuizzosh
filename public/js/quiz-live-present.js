const quizLivePresentShell = document.querySelector("[data-quiz-live-present]");
const quizLivePresentDataScript = document.querySelector("[data-quiz-live-present-data]");

if (quizLivePresentShell && quizLivePresentDataScript) {
  const stateUrl = quizLivePresentShell.dataset.stateUrl || "";
  const STATE_POLL_INTERVAL_MS = 500;
  const PHASE_SYNC_INTERVAL_MS = 150;
  let liveSnapshot = {};
  let boundarySyncKey = "";
  let lastRenderSignature = "";
  let finalCelebrationKey = "";
  let animatedChoiceStatsKey = "";
  let serverClockOffsetMs = 0;
  const audioController =
    typeof window.createQuizLiveAudioController === "function"
      ? window.createQuizLiveAudioController({
          theme: "dark",
          volume: 0.34,
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

  const presentIcons = {
    spark:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8Z"></path></svg>',
    users:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="3"></circle><path d="M22 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>',
    clock:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 3"></path></svg>',
    link:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.07 0l2.12-2.12a5 5 0 0 0-7.07-7.07L10.7 5.22"></path><path d="M14 11a5 5 0 0 0-7.07 0L4.81 13.12a5 5 0 1 0 7.07 7.07L13.3 18.8"></path></svg>',
    qr:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h6v6H4z"></path><path d="M14 4h6v6h-6z"></path><path d="M4 14h6v6H4z"></path><path d="M15 15h1"></path><path d="M18 15h2"></path><path d="M15 18h5"></path><path d="M18 14v6"></path></svg>',
    chart:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20V10"></path><path d="M10 20V4"></path><path d="M16 20v-7"></path><path d="M22 20v-3"></path></svg>',
    trophy:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 21h8"></path><path d="M12 17v4"></path><path d="M7 4h10v4a5 5 0 0 1-10 0Z"></path><path d="M17 6h2a2 2 0 0 1 0 4h-2"></path><path d="M7 6H5a2 2 0 1 0 0 4h2"></path></svg>',
    target:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"></circle><circle cx="12" cy="12" r="3"></circle><path d="M12 2v2"></path><path d="M12 20v2"></path><path d="m4.93 4.93 1.41 1.41"></path><path d="m17.66 17.66 1.41 1.41"></path></svg>',
    crown:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 8 5 4 4-6 4 6 5-4-2 10H5Z"></path><path d="M5 18h14"></path></svg>',
    pulse:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h4l2-5 4 10 2-5h6"></path></svg>'
  };
  const choiceLetters = ["A", "B", "C", "D", "E", "F"];

  try {
    liveSnapshot = JSON.parse(quizLivePresentDataScript.textContent || "{}");
  } catch (error) {
    liveSnapshot = {};
  }

  const syncServerClock = (snapshot) => {
    const serverNowMs = snapshot?.serverNow ? new Date(snapshot.serverNow).getTime() : 0;

    if (serverNowMs) {
      serverClockOffsetMs = serverNowMs - Date.now();
    }
  };

  const getNowMs = () => Date.now() + serverClockOffsetMs;

  syncServerClock(liveSnapshot);

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

  const getQuestionTimebarProgress = (snapshot) => {
    const startedAtMs = snapshot.questionStartedAt ? new Date(snapshot.questionStartedAt).getTime() : 0;
    const endsAtMs = snapshot.phaseEndsAt ? new Date(snapshot.phaseEndsAt).getTime() : 0;

    if (!startedAtMs || !endsAtMs || endsAtMs <= startedAtMs) {
      return 1;
    }

    const totalMs = Math.max(1, endsAtMs - startedAtMs);
    const remainingMs = Math.max(0, endsAtMs - getNowMs());

    return Math.min(1, remainingMs / totalMs);
  };

  const renderQuestionTimebar = (snapshot) => {
    const progress = getQuestionTimebarProgress(snapshot);
    const progressPercent = Math.max(0, Math.min(100, progress * 100));
    const dangerClass = progress <= 0.22 ? "is-danger" : progress <= 0.45 ? "is-warning" : "";

    return `
      <div class="quiz-present-timebar ${dangerClass}" aria-hidden="true">
        <span
          class="quiz-present-timebar-fill"
          data-present-timebar-fill
          style="width:${progressPercent}%"
        ></span>
      </div>
    `;
  };

  const getCurrentBoundaryKey = (snapshot) =>
    `${snapshot.status || ""}:${snapshot.phaseMode || ""}:${snapshot.phaseEndsAt || ""}`;

  const getRenderSignature = (snapshot) => {
    const baseSignature = {
      status: snapshot.status || "",
      phaseMode: snapshot.phaseMode || "",
      phaseEndsAt: snapshot.phaseEndsAt || "",
      participantCount: snapshot.participantCount || 0,
      totalQuestions: snapshot.totalQuestions || 0,
      currentQuestionIndex: snapshot.currentQuestionIndex || 0,
      nextQuestionPosition: snapshot.nextQuestionPosition || 0
    };

    if (snapshot.status === "lobby") {
      return JSON.stringify({
        ...baseSignature,
        title: snapshot.quiz?.title || "",
        quizCode: snapshot.quiz?.quizCode || "",
        participants: (snapshot.participants || []).slice(0, 24).map((participant) => ({
          id: participant.id,
          name: participant.displayName
        }))
      });
    }

    if (snapshot.status === "question") {
      return JSON.stringify({
        ...baseSignature,
        answeredCount: snapshot.answeredCount || 0,
        question: {
          id: snapshot.currentQuestion?.id || "",
          prompt: snapshot.currentQuestion?.prompt || "",
          questionType: snapshot.currentQuestion?.questionType || "",
          position: snapshot.currentQuestion?.position || 0,
          imageUrl: snapshot.currentQuestion?.imageUrl || "",
          acceptedAnswer: snapshot.currentQuestion?.acceptedAnswer || "",
          correctResponseCount: snapshot.currentQuestion?.correctResponseCount || 0,
          incorrectResponseCount: snapshot.currentQuestion?.incorrectResponseCount || 0,
          typedResponseCount: snapshot.currentQuestion?.typedResponseCount || 0,
          choices: (snapshot.currentQuestion?.choices || []).map((choice) => ({
            id: choice.id,
            label: choice.label
          }))
        }
      });
    }

    if (snapshot.status === "leaderboard" && snapshot.phaseMode === "chart") {
      return JSON.stringify({
        ...baseSignature,
        answeredCount: snapshot.answeredCount || 0,
        answeredPercentage: snapshot.answeredPercentage || 0,
        question: {
          id: snapshot.currentQuestion?.id || "",
          prompt: snapshot.currentQuestion?.prompt || "",
          questionType: snapshot.currentQuestion?.questionType || "",
          position: snapshot.currentQuestion?.position || 0,
          imageUrl: snapshot.currentQuestion?.imageUrl || "",
          acceptedAnswer: snapshot.currentQuestion?.acceptedAnswer || "",
          correctResponseCount: snapshot.currentQuestion?.correctResponseCount || 0,
          incorrectResponseCount: snapshot.currentQuestion?.incorrectResponseCount || 0,
          typedResponseCount: snapshot.currentQuestion?.typedResponseCount || 0,
          choices: (snapshot.currentQuestion?.choices || []).map((choice) => ({
            id: choice.id,
            label: choice.label,
            isCorrect: Boolean(choice.isCorrect),
            selectedCount: choice.selectedCount || 0,
            selectedPercent: choice.selectedPercent || 0
          }))
        }
      });
    }

    if (snapshot.status === "leaderboard" && snapshot.phaseMode === "leaderboard") {
      return JSON.stringify({
        ...baseSignature,
        leaderboard: (snapshot.leaderboard || []).slice(0, 10).map((entry) => ({
          rank: entry.rank,
          name: entry.displayName,
          answers: entry.answerSummaryLabel,
          time: entry.totalResponseTimeLabel
        }))
      });
    }

    if (snapshot.status === "leaderboard" && snapshot.phaseMode === "countdown") {
      return JSON.stringify(baseSignature);
    }

    return JSON.stringify({
      ...baseSignature,
      leaderboard: (snapshot.leaderboard || []).slice(0, 15).map((entry) => ({
        rank: entry.rank,
        name: entry.displayName,
        answers: entry.answerSummaryLabel,
        time: entry.totalResponseTimeLabel
      }))
    });
  };

  const renderIcon = (iconName) => presentIcons[iconName] || presentIcons.spark;

  const renderMetaChip = (iconName, label, value, extraClass = "", valueAttributes = "") => `
    <div class="quiz-present-meta-chip ${extraClass}">
      <span class="quiz-present-chip-icon" aria-hidden="true">${renderIcon(iconName)}</span>
      <span class="quiz-present-meta-copy">
        <span>${escapeHtml(label)}</span>
        <strong ${valueAttributes}>${escapeHtml(value)}</strong>
      </span>
    </div>
  `;

  const renderInlineFact = (iconName, label, value) => `
    <div class="quiz-present-inline-fact">
      <span class="quiz-present-inline-icon" aria-hidden="true">${renderIcon(iconName)}</span>
      <div class="quiz-present-inline-copy">
        <strong>${escapeHtml(label)}</strong>
        <span>${escapeHtml(value)}</span>
      </div>
    </div>
  `;

  const renderCelebrationTitle = (value) => {
    const title = String(value || "").trim();

    if (!title) {
      return "";
    }

    return `
      <span class="quiz-present-celebration-title" aria-label="${escapeHtml(title)}">
        ${Array.from(title)
          .map((character, index) =>
            character === " "
              ? '<span class="quiz-present-celebration-space" aria-hidden="true">&nbsp;</span>'
              : `<span class="quiz-present-celebration-letter" style="--celebration-index:${index}" aria-hidden="true">${escapeHtml(character)}</span>`
          )
          .join("")}
      </span>
    `;
  };

  const getChoiceStatsAnimationKey = (snapshot) =>
    snapshot.status === "leaderboard" && snapshot.phaseMode === "chart"
      ? `${snapshot.sessionId || ""}:${snapshot.currentQuestion?.id || ""}:chart`
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
      window.requestAnimationFrame(() => {
        meterNodes.forEach((node) => {
          node.style.width = `${clampPercent(node.dataset.targetWidth)}%`;
        });
        window.requestAnimationFrame(step);
      });
    });
  };

  const hashPresentLobbyValue = (value) => {
    let hash = 0;
    const input = String(value || "");

    for (let index = 0; index < input.length; index += 1) {
      hash = (hash * 31 + input.charCodeAt(index)) | 0;
    }

    return Math.abs(hash);
  };

  const buildLobbyParticipantClasses = (participant) => {
    const seed = hashPresentLobbyValue(`${participant.id || ""}:${participant.displayName || ""}`);
    const sizeClass = ["is-size-s", "is-size-m", "is-size-l", "is-size-xl"][seed % 4];
    const toneClass = ["is-tone-a", "is-tone-b", "is-tone-c", "is-tone-d"][Math.floor(seed / 3) % 4];
    const motionClass = ["is-tilt-left", "is-tilt-right", "is-flat"][Math.floor(seed / 11) % 3];

    return [sizeClass, toneClass, motionClass].filter(Boolean).join(" ");
  };

  const buildLobbyParticipantStyle = (participant, index, total) => {
    const seed = hashPresentLobbyValue(`${participant.id || ""}:${participant.displayName || ""}`);
    const angle = (((seed % 360) + index * 137.5) * Math.PI) / 180;
    const spread = total <= 1 ? 0 : 8 + Math.sqrt((index + 0.7) / total) * 34 + ((seed % 9) - 4);
    const x = Math.cos(angle) * spread;
    const y = Math.sin(angle) * spread * 0.76;
    const left = Math.min(88, Math.max(12, 50 + x)).toFixed(2);
    const top = Math.min(84, Math.max(18, 50 + y)).toFixed(2);
    const delay = (index * 0.06 + (seed % 5) * 0.03).toFixed(2);
    const rotate = (((seed % 7) - 3) * 1.6).toFixed(2);

    return `--bubble-left:${left}%; --bubble-top:${top}%; --bubble-delay:${delay}s; --bubble-rotate:${rotate}deg;`;
  };

  const renderLobbyParticipants = (snapshot) => {
    if (!snapshot.participants?.length) {
      return '<p class="quiz-present-lobby-empty">Waiting for players to join the lobby.</p>';
    }

    const orderedParticipants = [...snapshot.participants].sort((left, right) => {
      const leftSeed = hashPresentLobbyValue(`${left.id || ""}:${left.displayName || ""}`);
      const rightSeed = hashPresentLobbyValue(`${right.id || ""}:${right.displayName || ""}`);
      return leftSeed - rightSeed;
    });
    const visibleParticipants = orderedParticipants.slice(0, 18);
    const hiddenCount = Math.max(0, snapshot.participants.length - visibleParticipants.length);

    return `
      <div class="quiz-present-lobby-player-cloud">
        ${visibleParticipants
          .map(
            (participant, index) => `
              <span
                class="quiz-present-lobby-player-pill ${buildLobbyParticipantClasses(participant)}"
                style="${buildLobbyParticipantStyle(participant, index, visibleParticipants.length)}"
              >${escapeHtml(participant.displayName)}</span>
            `
          )
          .join("")}
        ${
          hiddenCount
            ? `
              <span
                class="quiz-present-lobby-player-more is-size-s is-tone-b is-flat"
                style="${buildLobbyParticipantStyle({ id: `more-${hiddenCount}`, displayName: `+${hiddenCount} more` }, visibleParticipants.length, visibleParticipants.length + 1)}"
              >+${hiddenCount} more</span>
            `
            : ""
        }
      </div>
    `;
  };

  const renderFinalPodiumSlot = (entry, rank) => {
    const toneClass =
      rank === 1 ? "is-gold" : rank === 2 ? "is-silver" : "is-bronze";

    if (!entry) {
      return `
        <div class="quiz-present-podium-slot quiz-present-podium-slot-${rank} is-empty">
          <article class="quiz-present-podium-card ${toneClass}">
            <span class="quiz-present-podium-medal">#${rank}</span>
            <strong>Open spot</strong>
            <span>Waiting for a finisher</span>
          </article>
          <div class="quiz-present-podium-stage ${toneClass}">
            <span>${rank}</span>
          </div>
        </div>
      `;
    }

    return `
      <div class="quiz-present-podium-slot quiz-present-podium-slot-${rank}">
        <article class="quiz-present-podium-card ${toneClass}">
          <span class="quiz-present-podium-medal">#${entry.rank}</span>
          <strong>${escapeHtml(entry.displayName)}</strong>
          <span>${escapeHtml(entry.answerSummaryLabel)} correct</span>
          <span>${escapeHtml(entry.totalResponseTimeLabel)}</span>
        </article>
        <div class="quiz-present-podium-stage ${toneClass}">
          <span>${rank}</span>
        </div>
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
            <div class="quiz-live-choice-card ${choiceColors[index % choiceColors.length]} has-stat ${choice.isCorrect ? `is-correct is-reveal-correct ${options.animateStats ? "is-present-correct-focus" : ""}` : "is-wrong is-reveal-wrong is-muted"}">
              <div class="quiz-live-choice-copy">
                <span class="quiz-present-choice-badge">${choiceLetters[index] || index + 1}</span>
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

  const renderFreeTextStage = () => `
    <section class="quiz-live-free-text-prompt quiz-live-free-text-prompt-dark">
      <div class="quiz-live-free-text-prompt-icon" aria-hidden="true">Aa</div>
      <div class="quiz-live-free-text-prompt-copy">
        <span>Free text</span>
        <strong>Players type the answer on their own device.</strong>
      </div>
    </section>
  `;

  const renderFreeTextReveal = (snapshot) => {
    const typedCount = Number(snapshot.currentQuestion?.typedResponseCount || 0);
    const typedLabel = typedCount === 1 ? "1 player typed an answer" : `${typedCount} players typed an answer`;

    return `
      <section class="quiz-live-free-text-reveal quiz-live-free-text-reveal-dark">
        <article class="quiz-live-free-text-answer-card">
          <span>Correct answer</span>
          <strong>${escapeHtml(snapshot.currentQuestion?.acceptedAnswer || "")}</strong>
        </article>
        <div class="quiz-live-free-text-stats">
          <article class="quiz-live-free-text-stat">
            <span>Correct</span>
            <strong>${snapshot.currentQuestion?.correctResponseCount || 0}</strong>
          </article>
          <article class="quiz-live-free-text-stat">
            <span>Wrong</span>
            <strong>${snapshot.currentQuestion?.incorrectResponseCount || 0}</strong>
          </article>
          <article class="quiz-live-free-text-stat">
            <span>Typed</span>
            <strong>${escapeHtml(typedLabel)}</strong>
          </article>
        </div>
      </section>
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
                <span class="quiz-present-choice-badge">${choiceLetters[index] || index + 1}</span>
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
      return '<p class="quiz-live-muted">Leaderboard will appear once players answer.</p>';
    }

    return `
      <div class="quiz-live-leaderboard-list">
        ${snapshot.leaderboard
          .slice(0, limit)
          .map(
            (entry) => `
              <article class="quiz-live-leaderboard-row ${entry.rank === 1 ? "is-rank-1" : ""}">
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

  const renderFinalLeaderboard = (snapshot) => {
    if (!snapshot.leaderboard?.length) {
      return '<p class="quiz-live-muted">Waiting for final standings.</p>';
    }

    const rankedEntries = snapshot.leaderboard.slice(0, 15);
    const podiumEntries = new Map(rankedEntries.slice(0, 3).map((entry) => [entry.rank, entry]));
    const remainingEntries = rankedEntries.slice(3, 15);
    const lowerListStart = remainingEntries.length ? remainingEntries[0].rank : 4;
    const lowerListEnd = remainingEntries.length ? remainingEntries[remainingEntries.length - 1].rank : 15;

    return `
      <div class="quiz-live-final-board">
        <div class="quiz-present-podium-grid">
          ${renderFinalPodiumSlot(podiumEntries.get(2), 2)}
          ${renderFinalPodiumSlot(podiumEntries.get(1), 1)}
          ${renderFinalPodiumSlot(podiumEntries.get(3), 3)}
        </div>
        ${
          remainingEntries.length
            ? `
              <div class="quiz-live-final-list quiz-present-final-list">
                <div class="quiz-present-final-list-head">
                  <div>
                    <span class="section-pill">Leaderboard</span>
                    <strong>Ranks ${lowerListStart} to ${lowerListEnd}</strong>
                  </div>
                  <span>Top 15 overall</span>
                </div>
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

  const renderStage = ({
    iconName,
    label,
    title,
    titleHtml = "",
    description,
    chips = [],
    body = "",
    stageClass = ""
  }) => `
    <section class="quiz-present-stage ${stageClass}">
      <header class="quiz-present-header">
        <div class="quiz-present-brandline">
          <span class="quiz-present-icon-badge" aria-hidden="true">${renderIcon(iconName)}</span>
          <div class="quiz-present-brand-copy">
            <span class="section-pill">${escapeHtml(label)}</span>
            <span class="quiz-present-brand-hint">Kuizzosh live screen</span>
          </div>
        </div>
        ${chips.length ? `<div class="quiz-present-meta-row">${chips.join("")}</div>` : ""}
      </header>
      <div class="quiz-present-headline">
        <h1>${titleHtml || escapeHtml(title)}</h1>
        ${description ? `<p>${escapeHtml(description)}</p>` : ""}
      </div>
      ${body}
    </section>
  `;

  const createFinalConfettiBurst = (targetStage, burstIndex) => {
    const confettiLayer = document.createElement("div");
    const confettiPalette = ["#ffe766", "#ff7d6f", "#63d6ff", "#7ef0a1", "#ffffff", "#ffc7e8"];
    confettiLayer.className = "quiz-present-confetti-layer";
    confettiLayer.setAttribute("data-present-confetti", "");
    confettiLayer.style.animationDelay = `${burstIndex * 0.06}s`;

    for (let index = 0; index < 92; index += 1) {
      const piece = document.createElement("span");
      const size = 8 + Math.random() * 12;
      piece.className = "quiz-present-confetti-piece";
      piece.style.left = `${Math.random() * 100}%`;
      piece.style.width = `${size}px`;
      piece.style.height = `${size * (0.7 + Math.random() * 0.9)}px`;
      piece.style.background = confettiPalette[Math.floor(Math.random() * confettiPalette.length)];
      piece.style.animationDelay = `${Math.random() * 1.6}s`;
      piece.style.animationDuration = `${6.6 + Math.random() * 2.6}s`;
      piece.style.setProperty("--confetti-drift", `${-240 + Math.random() * 480}px`);
      piece.style.setProperty("--confetti-rotate", `${240 + Math.random() * 960}deg`);
      piece.style.borderRadius = Math.random() > 0.45 ? "999px" : "4px";
      confettiLayer.appendChild(piece);
    }

    targetStage.appendChild(confettiLayer);

    window.setTimeout(() => {
      if (confettiLayer.isConnected) {
        confettiLayer.remove();
      }
    }, 12000);
  };

  const launchFinalConfetti = (celebrationKey) => {
    const targetStage = quizLivePresentShell.querySelector(".quiz-present-stage-ended");
    if (!targetStage) {
      return;
    }

    finalCelebrationKey = celebrationKey;

    targetStage.querySelectorAll("[data-present-confetti]").forEach((node) => {
      node.remove();
    });

    [0, 1600, 3200, 4800, 6400].forEach((delayMs, burstIndex) => {
      window.setTimeout(() => {
        if (!targetStage.isConnected || finalCelebrationKey !== celebrationKey) {
          return;
        }

        createFinalConfettiBurst(targetStage, burstIndex);
      }, delayMs);
    });
  };

  const maybeCelebrateFinalLeaderboard = (snapshot) => {
    const celebrationKey = JSON.stringify({
      quizId: snapshot.quiz?.id || "",
      sessionId: snapshot.sessionId || "",
      winners: (snapshot.leaderboard || []).slice(0, 3).map((entry) => entry.displayName),
      total: snapshot.leaderboard?.length || 0
    });

    if (finalCelebrationKey === celebrationKey) {
      return;
    }

    window.requestAnimationFrame(() => {
      launchFinalConfetti(celebrationKey);
    });
  };

  const applySnapshot = (snapshot, force = false) => {
    liveSnapshot = snapshot || {};
    syncServerClock(liveSnapshot);

    if (liveSnapshot.status !== "ended") {
      finalCelebrationKey = "";
    }

    const renderSignature = getRenderSignature(liveSnapshot);
    if (!force && renderSignature === lastRenderSignature) {
      return;
    }

    lastRenderSignature = renderSignature;
    render(liveSnapshot);
  };

  const render = (snapshot) => {
    if (audioController) {
      audioController.sync(snapshot);
    }

    const isChartStage = snapshot.status === "leaderboard" && snapshot.phaseMode === "chart";
    if (!isChartStage) {
      animatedChoiceStatsKey = "";
    }

    if (snapshot.status === "lobby") {
      const joinLink = `${window.location.origin}${snapshot.quiz?.joinUrl || ""}`;
      const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=${encodeURIComponent(joinLink)}`;

      quizLivePresentShell.innerHTML = renderStage({
        iconName: "spark",
        label: "Live Quiz Lobby",
        title: snapshot.quiz?.title || "",
        description: "",
        chips: [
          renderMetaChip("users", "Players ready", String(snapshot.participantCount || 0)),
          renderMetaChip("target", "Room code", snapshot.quiz?.quizCode || "")
        ],
        body: `
          <div class="quiz-present-lobby-grid">
            <div class="quiz-present-lobby-main">
              <div class="quiz-present-lobby-player-head">
                <div>
                  <span class="section-pill">Players joined</span>
                  <strong>${escapeHtml(String(snapshot.participantCount || 0))} in the room</strong>
                </div>
                <span>Live lobby</span>
              </div>
              ${renderLobbyParticipants(snapshot)}
            </div>
            <div class="quiz-present-qr-orbit">
              <img src="${qrUrl}" alt="Quiz join QR code" />
            </div>
            <div class="quiz-present-lobby-bottom">
              <div class="quiz-present-code-stack">
                <span class="quiz-present-code-label">Enter this code</span>
                <strong class="quiz-present-code">${escapeHtml(snapshot.quiz?.quizCode || "")}</strong>
              </div>
              <div class="quiz-present-inline-facts">
                ${renderInlineFact("link", "Join link", joinLink)}
                ${renderInlineFact("qr", "Scan on phone", "Use your camera or QR app to jump in instantly")}
              </div>
            </div>
          </div>
        `,
        stageClass: "quiz-present-stage-lobby"
      });
      return;
    }

    if (snapshot.status === "question") {
      quizLivePresentShell.innerHTML = renderStage({
        iconName: "pulse",
        label: `Question ${snapshot.currentQuestion?.position || 1} of ${snapshot.totalQuestions || 1}`,
        title: snapshot.currentQuestion?.prompt || "",
        description: "",
        chips: [
          renderMetaChip("users", "Answered", `${snapshot.answeredCount || 0} / ${snapshot.participantCount || 0}`),
          renderMetaChip(
            "clock",
            "Time left",
            formatCountdown(snapshot.phaseEndsAt),
            "quiz-present-meta-chip-countdown",
            "data-present-countdown"
          )
        ],
        body: `
          ${renderQuestionTimebar(snapshot)}
          ${renderQuestionMedia(snapshot)}
          ${
            snapshot.currentQuestion?.questionType === "free_text"
              ? renderFreeTextStage(snapshot)
              : renderQuestionChoices(snapshot)
          }
        `
      });
      return;
    }

    if (isChartStage) {
      const shouldAnimateStats =
        snapshot.currentQuestion?.questionType !== "free_text" && shouldAnimateChoiceStats(snapshot);

      quizLivePresentShell.innerHTML = renderStage({
        iconName: "chart",
        label: "Answer Breakdown",
        title: snapshot.currentQuestion?.prompt || "",
        description: "",
        chips: [
          renderMetaChip("chart", "Answers locked", `${snapshot.answeredPercentage || 0}% participated`),
          renderMetaChip(
            "clock",
            "Next reveal",
            formatCountdown(snapshot.phaseEndsAt),
            "quiz-present-meta-chip-countdown",
            "data-present-countdown"
          )
        ],
        body: `
          ${renderQuestionMedia(snapshot)}
          ${
            snapshot.currentQuestion?.questionType === "free_text"
              ? renderFreeTextReveal(snapshot)
              : renderChoiceChart(snapshot, { animateStats: shouldAnimateStats })
          }
        `
      });

      if (shouldAnimateStats) {
        animateChoiceStats(quizLivePresentShell);
        animatedChoiceStatsKey = getChoiceStatsAnimationKey(snapshot);
      }

      return;
    }

    if (snapshot.status === "leaderboard" && snapshot.phaseMode === "leaderboard") {
      quizLivePresentShell.innerHTML = renderStage({
        iconName: "trophy",
        label: "Leaderboard",
        title: "Current rankings",
        description: "",
        chips: [
          renderMetaChip("users", "Players ranked", String(snapshot.leaderboard?.length || 0)),
          renderMetaChip(
            "clock",
            "Next question",
            formatCountdown(snapshot.phaseEndsAt),
            "quiz-present-meta-chip-countdown",
            "data-present-countdown"
          )
        ],
        body: renderLeaderboardRows(snapshot, { limit: 10 }),
        stageClass: "quiz-present-stage-leaderboard"
      });
      return;
    }

    if (snapshot.status === "leaderboard" && snapshot.phaseMode === "countdown") {
      const nextQuestionPosition = snapshot.nextQuestionPosition || (snapshot.currentQuestionIndex || 0) + 2;
      const countdownLabel = nextQuestionPosition === 1 ? "First Question" : "Next Question";

      quizLivePresentShell.innerHTML = renderStage({
        iconName: "spark",
        label: countdownLabel,
        title: `Question ${nextQuestionPosition} starts in`,
        description: "",
        chips: [
          renderMetaChip(
            "clock",
            "Countdown",
            formatCountdown(snapshot.phaseEndsAt),
            "quiz-present-meta-chip-countdown",
            "data-present-countdown"
          )
        ],
        body: `
          <div class="quiz-present-countdown-shell">
            <div class="quiz-present-countdown-orbit">
              <div class="quiz-live-big-countdown" data-present-big-countdown>${formatCountdownNumber(snapshot.phaseEndsAt)}</div>
            </div>
          </div>
        `,
        stageClass: "quiz-present-stage-countdown quiz-live-countdown-stage"
      });
      return;
    }

    quizLivePresentShell.innerHTML = renderStage({
      iconName: "crown",
      label: "Quiz Finished",
      title: "Congratulations",
      titleHtml: renderCelebrationTitle("Congratulations"),
      description: "",
      chips: [
        renderMetaChip("trophy", "Winners shown", String(Math.min(3, snapshot.leaderboard?.length || 0))),
        renderMetaChip("users", "Total ranked", String(snapshot.leaderboard?.length || 0))
      ],
      body: renderFinalLeaderboard(snapshot),
      stageClass: "quiz-present-stage-ended"
    });
    maybeCelebrateFinalLeaderboard(snapshot);
  };

  const loadState = async () => {
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
    if (payload.snapshot) {
      boundarySyncKey = "";
      applySnapshot(payload.snapshot);
    }
  };

  applySnapshot(liveSnapshot, true);

  window.setInterval(() => {
    loadState().catch(() => {});
  }, STATE_POLL_INTERVAL_MS);

  window.setInterval(() => {
    quizLivePresentShell.querySelectorAll("[data-present-countdown]").forEach((node) => {
      node.textContent = formatCountdown(liveSnapshot.phaseEndsAt);
    });

    quizLivePresentShell.querySelectorAll("[data-present-big-countdown]").forEach((node) => {
      node.textContent = formatCountdownNumber(liveSnapshot.phaseEndsAt);
    });

    quizLivePresentShell.querySelectorAll("[data-present-timebar-fill]").forEach((node) => {
      const progress = getQuestionTimebarProgress(liveSnapshot);
      const progressPercent = Math.max(0, Math.min(100, progress * 100));
      const timebar = node.closest(".quiz-present-timebar");

      node.style.width = `${progressPercent}%`;

      if (timebar) {
        timebar.classList.toggle("is-warning", progress <= 0.45 && progress > 0.22);
        timebar.classList.toggle("is-danger", progress <= 0.22);
      }
    });

    if (liveSnapshot.phaseEndsAt) {
      const phaseDeadline = new Date(liveSnapshot.phaseEndsAt).getTime();
      const currentBoundaryKey = getCurrentBoundaryKey(liveSnapshot);

      if (getNowMs() >= phaseDeadline && currentBoundaryKey && boundarySyncKey !== currentBoundaryKey) {
        boundarySyncKey = currentBoundaryKey;
        loadState().catch(() => {});
      }
    }
  }, PHASE_SYNC_INTERVAL_MS);
}
