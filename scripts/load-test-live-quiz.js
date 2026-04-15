#!/usr/bin/env node

const { performance } = require("perf_hooks");

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || "").trim();

    if (!token.startsWith("--")) {
      continue;
    }

    const trimmed = token.slice(2);

    if (!trimmed) {
      continue;
    }

    if (trimmed.includes("=")) {
      const [key, ...rest] = trimmed.split("=");
      args[key] = rest.join("=");
      continue;
    }

    const nextToken = argv[index + 1];

    if (!nextToken || String(nextToken).startsWith("--")) {
      args[trimmed] = true;
      continue;
    }

    args[trimmed] = nextToken;
    index += 1;
  }

  return args;
}

function printUsage() {
  console.log(`
Kuizzosh live quiz load test

Usage:
  node scripts/load-test-live-quiz.js --quizCode=273935 [options]

Required:
  --quizCode             6-digit live quiz code

Optional:
  --baseUrl              App URL. Default: http://localhost:3000
  --players              Number of simulated players. Default: 50
  --joinConcurrency      Concurrent joins. Default: all players
  --answerConcurrency    Concurrent answers. Default: all players
  --pollRounds           State fetch rounds after join/answer. Default: 3
  --questionWaitMs       Wait for host to start question. Default: 120000
  --joinPrefix           Player name prefix. Default: LoadBot
  --skipAnswers          Only test join + state load

Examples:
  node scripts/load-test-live-quiz.js --baseUrl=http://localhost:3000 --quizCode=273935 --players=60
  node scripts/load-test-live-quiz.js --baseUrl=https://kuizzosh.vercel.app --quizCode=273935 --players=75 --skipAnswers
`);
}

function toPositiveInteger(value, fallbackValue) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallbackValue;
}

function clampConcurrency(value, total) {
  return Math.max(1, Math.min(toPositiveInteger(value, total), total));
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getSetCookieValues(headers) {
  if (!headers) {
    return [];
  }

  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }

  const setCookie = headers.get("set-cookie");
  return setCookie ? [setCookie] : [];
}

function buildCookieHeader(headers) {
  return getSetCookieValues(headers)
    .map((value) => String(value || "").split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

function encodeFormBody(payload) {
  const form = new URLSearchParams();

  Object.entries(payload || {}).forEach(([key, value]) => {
    form.set(key, String(value ?? ""));
  });

  return form.toString();
}

function percentile(values, percentileValue) {
  if (!values.length) {
    return 0;
  }

  const sortedValues = [...values].sort((left, right) => left - right);
  const position = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil((percentileValue / 100) * sortedValues.length) - 1)
  );

  return sortedValues[position];
}

function summarizeTimings(label, timings) {
  const safeTimings = timings.filter((value) => Number.isFinite(value));

  if (!safeTimings.length) {
    return `${label}: no data`;
  }

  const total = safeTimings.reduce((sum, value) => sum + value, 0);

  return [
    `${label}: count=${safeTimings.length}`,
    `avg=${(total / safeTimings.length).toFixed(1)}ms`,
    `p50=${percentile(safeTimings, 50).toFixed(1)}ms`,
    `p95=${percentile(safeTimings, 95).toFixed(1)}ms`,
    `max=${Math.max(...safeTimings).toFixed(1)}ms`
  ].join(" | ");
}

function createTimer() {
  const startedAt = performance.now();

  return () => performance.now() - startedAt;
}

async function runWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function consume() {
    while (true) {
      const index = cursor;
      cursor += 1;

      if (index >= items.length) {
        return;
      }

      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () => consume())
  );

  return results;
}

async function fetchJson(url, options = {}) {
  const timer = createTimer();
  const response = await fetch(url, options);
  const elapsedMs = timer();
  let payload = null;

  try {
    payload = await response.json();
  } catch (error) {
    payload = null;
  }

  return {
    ok: response.ok,
    status: response.status,
    elapsedMs,
    payload
  };
}

async function joinPlayer(baseUrl, quizCode, displayName) {
  const timer = createTimer();
  const response = await fetch(`${baseUrl}/quizzes/join/${quizCode}/join`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: encodeFormBody({
      displayName
    })
  });
  const elapsedMs = timer();
  const cookieHeader = buildCookieHeader(response.headers);

  return {
    ok: response.status === 302 && Boolean(cookieHeader),
    status: response.status,
    elapsedMs,
    cookieHeader
  };
}

async function loadPlayerState(baseUrl, quizCode, cookieHeader = "") {
  return fetchJson(`${baseUrl}/api/quizzes/join/${quizCode}/state`, {
    headers: {
      Accept: "application/json",
      ...(cookieHeader ? { Cookie: cookieHeader } : {})
    }
  });
}

function buildAnswerPayload(snapshot) {
  const question = snapshot?.currentQuestion || null;

  if (!question?.id) {
    return null;
  }

  if (question.questionType === "free_text") {
    return {
      answerText: "load test"
    };
  }

  const firstChoiceId = question.choices?.[0]?.id || null;

  if (!firstChoiceId) {
    return null;
  }

  return {
    choiceIds: [firstChoiceId]
  };
}

async function submitAnswer(baseUrl, quizCode, cookieHeader, answerPayload) {
  return fetchJson(`${baseUrl}/api/quizzes/join/${quizCode}/answer`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(cookieHeader ? { Cookie: cookieHeader } : {})
    },
    body: JSON.stringify(answerPayload)
  });
}

async function waitForQuestion(baseUrl, quizCode, cookieHeader, timeoutMs) {
  const deadlineAt = Date.now() + timeoutMs;

  while (Date.now() < deadlineAt) {
    const stateResponse = await loadPlayerState(baseUrl, quizCode, cookieHeader);

    if (
      stateResponse.ok &&
      stateResponse.payload?.snapshot?.status === "question" &&
      stateResponse.payload.snapshot.currentQuestion?.id
    ) {
      return stateResponse;
    }

    await sleep(1000);
  }

  throw new Error(
    `Timed out after ${(timeoutMs / 1000).toFixed(0)}s waiting for the host to start a question.`
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || args.h) {
    printUsage();
    return;
  }

  const quizCode = String(args.quizCode || args.quiz || "").trim();

  if (!/^\d{6}$/.test(quizCode)) {
    printUsage();
    throw new Error("Provide a valid 6-digit --quizCode.");
  }

  const baseUrl = String(args.baseUrl || "http://localhost:3000").replace(/\/+$/, "");
  const playerCount = toPositiveInteger(args.players, 50);
  const joinPrefix = String(args.joinPrefix || "LoadBot").trim() || "LoadBot";
  const pollRounds = toPositiveInteger(args.pollRounds, 3);
  const questionWaitMs = toPositiveInteger(args.questionWaitMs, 120000);
  const skipAnswers = Boolean(args.skipAnswers);
  const joinConcurrency = clampConcurrency(args.joinConcurrency, playerCount);
  const answerConcurrency = clampConcurrency(args.answerConcurrency, playerCount);

  console.log(`Base URL: ${baseUrl}`);
  console.log(`Quiz code: ${quizCode}`);
  console.log(`Players: ${playerCount}`);
  console.log(`Join concurrency: ${joinConcurrency}`);
  console.log(`Answer concurrency: ${answerConcurrency}`);
  console.log(`Poll rounds: ${pollRounds}`);
  console.log("");
  console.log("Checking lobby state...");

  const lobbyState = await loadPlayerState(baseUrl, quizCode);

  if (!lobbyState.ok) {
    throw new Error(`Unable to load quiz state. HTTP ${lobbyState.status}.`);
  }

  if (lobbyState.payload?.joinState !== "lobby") {
    throw new Error(
      `Quiz is not in lobby mode. Current joinState=${String(lobbyState.payload?.joinState || "unknown")}.`
    );
  }

  console.log(`Lobby is open. Current joined players: ${lobbyState.payload?.participantCount || 0}`);
  console.log("");
  console.log(`Joining ${playerCount} simulated players...`);

  const players = Array.from({ length: playerCount }, (_, index) => ({
    index: index + 1,
    name: `${joinPrefix} ${String(index + 1).padStart(3, "0")}`
  }));

  const joinResults = await runWithConcurrency(players, joinConcurrency, async (player) => {
    const joinResponse = await joinPlayer(baseUrl, quizCode, player.name);

    return {
      ...player,
      ...joinResponse
    };
  });

  const joinedPlayers = joinResults.filter((result) => result.ok);
  const failedJoins = joinResults.filter((result) => !result.ok);
  const joinTimings = joinResults.map((result) => result.elapsedMs);

  console.log(summarizeTimings("Join requests", joinTimings));
  console.log(`Join success: ${joinedPlayers.length}/${playerCount}`);

  if (failedJoins.length) {
    console.log("Join failures:");
    failedJoins.slice(0, 10).forEach((failure) => {
      console.log(`- ${failure.name}: HTTP ${failure.status}`);
    });
  }

  if (!joinedPlayers.length) {
    throw new Error("No simulated players joined successfully.");
  }

  console.log("");
  console.log(`Running ${pollRounds} player state rounds after join...`);

  const postJoinStateTimings = [];

  for (let round = 1; round <= pollRounds; round += 1) {
    const roundResults = await runWithConcurrency(joinedPlayers, playerCount, async (player) => {
      const stateResponse = await loadPlayerState(baseUrl, quizCode, player.cookieHeader);
      postJoinStateTimings.push(stateResponse.elapsedMs);

      return {
        ok: stateResponse.ok,
        status: stateResponse.status
      };
    });

    const roundFailures = roundResults.filter((result) => !result.ok);
    console.log(
      `Round ${round}: ${roundResults.length - roundFailures.length}/${roundResults.length} state requests succeeded`
    );
  }

  console.log(summarizeTimings("Post-join state requests", postJoinStateTimings));

  if (skipAnswers) {
    console.log("");
    console.log("Answer phase skipped by --skipAnswers.");
    printVerdict({
      playerCount,
      joinedPlayers,
      joinResults,
      postJoinStateTimings,
      answerResults: []
    });
    return;
  }

  console.log("");
  console.log("Waiting for the host to start the quiz...");
  console.log("Start the quiz now on the host screen.");

  const questionState = await waitForQuestion(
    baseUrl,
    quizCode,
    joinedPlayers[0].cookieHeader,
    questionWaitMs
  );
  const answerPayload = buildAnswerPayload(questionState.payload?.snapshot);

  if (!answerPayload) {
    throw new Error("Could not build an answer payload for the current question.");
  }

  console.log(
    `Question detected: ${questionState.payload?.snapshot?.currentQuestion?.prompt || "Untitled question"}`
  );
  console.log("");
  console.log(`Submitting answers from ${joinedPlayers.length} players...`);

  const answerResults = await runWithConcurrency(joinedPlayers, answerConcurrency, async (player) => {
    const answerResponse = await submitAnswer(baseUrl, quizCode, player.cookieHeader, answerPayload);

    return {
      ...player,
      ok: answerResponse.ok,
      status: answerResponse.status,
      elapsedMs: answerResponse.elapsedMs,
      payload: answerResponse.payload
    };
  });

  const answerTimings = answerResults.map((result) => result.elapsedMs);
  const failedAnswers = answerResults.filter((result) => !result.ok);

  console.log(summarizeTimings("Answer submissions", answerTimings));
  console.log(`Answer success: ${answerResults.length - failedAnswers.length}/${answerResults.length}`);

  if (failedAnswers.length) {
    console.log("Answer failures:");
    failedAnswers.slice(0, 10).forEach((failure) => {
      console.log(`- ${failure.name}: HTTP ${failure.status}`);
    });
  }

  console.log("");
  console.log(`Running ${pollRounds} player state rounds after answers...`);

  const postAnswerStateTimings = [];

  for (let round = 1; round <= pollRounds; round += 1) {
    const roundResults = await runWithConcurrency(joinedPlayers, playerCount, async (player) => {
      const stateResponse = await loadPlayerState(baseUrl, quizCode, player.cookieHeader);
      postAnswerStateTimings.push(stateResponse.elapsedMs);

      return {
        ok: stateResponse.ok,
        status: stateResponse.status
      };
    });

    const roundFailures = roundResults.filter((result) => !result.ok);
    console.log(
      `Round ${round}: ${roundResults.length - roundFailures.length}/${roundResults.length} state requests succeeded`
    );
  }

  console.log(summarizeTimings("Post-answer state requests", postAnswerStateTimings));
  console.log("");

  printVerdict({
    playerCount,
    joinedPlayers,
    joinResults,
    postJoinStateTimings,
    answerResults,
    postAnswerStateTimings
  });
}

function printVerdict(summary) {
  const joinSuccessRate =
    summary.joinResults.length > 0
      ? (summary.joinedPlayers.length / summary.joinResults.length) * 100
      : 0;
  const answerSuccessCount = summary.answerResults.filter((result) => result.ok).length;
  const answerSuccessRate =
    summary.answerResults.length > 0
      ? (answerSuccessCount / summary.answerResults.length) * 100
      : 100;
  const joinP95 = percentile(
    summary.joinResults.map((result) => result.elapsedMs).filter((value) => Number.isFinite(value)),
    95
  );
  const postJoinP95 = percentile(summary.postJoinStateTimings || [], 95);
  const answerP95 = percentile(
    summary.answerResults.map((result) => result.elapsedMs).filter((value) => Number.isFinite(value)),
    95
  );
  const postAnswerP95 = percentile(summary.postAnswerStateTimings || [], 95);

  const passed =
    joinSuccessRate >= 95 &&
    answerSuccessRate >= 95 &&
    joinP95 <= 2500 &&
    postJoinP95 <= 2500 &&
    answerP95 <= 2500 &&
    postAnswerP95 <= 2500;

  console.log(`Verdict for ${summary.playerCount} simulated players: ${passed ? "PASS" : "NEEDS WORK"}`);
  console.log(
    [
      `join success=${joinSuccessRate.toFixed(1)}%`,
      `join p95=${joinP95.toFixed(1)}ms`,
      `state p95=${postJoinP95.toFixed(1)}ms`,
      summary.answerResults.length
        ? `answer success=${answerSuccessRate.toFixed(1)}%`
        : "answer success=skipped",
      summary.answerResults.length ? `answer p95=${answerP95.toFixed(1)}ms` : "answer p95=skipped",
      summary.postAnswerStateTimings?.length
        ? `post-answer state p95=${postAnswerP95.toFixed(1)}ms`
        : "post-answer state p95=skipped"
    ].join(" | ")
  );
}

main().catch((error) => {
  console.error("");
  console.error(`Load test failed: ${error.message}`);
  process.exitCode = 1;
});
