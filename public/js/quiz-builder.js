const quizBuilderForm = document.querySelector("[data-quiz-builder]");
const quizBuilderDataScript = document.querySelector("[data-quiz-builder-data]");

if (quizBuilderForm && quizBuilderDataScript) {
  const hiddenStateInput = quizBuilderForm.querySelector("[data-builder-state-input]");
  const sectionNav = quizBuilderForm.querySelector("[data-section-nav]");
  const sectionPanels = quizBuilderForm.querySelector("[data-section-panels]");
  const addSectionButton = quizBuilderForm.querySelector("[data-add-section]");
  const settingsModal = quizBuilderForm.querySelector("[data-quiz-settings-modal]");
  const settingsOpenButtons = quizBuilderForm.querySelectorAll("[data-open-quiz-settings]");
  const settingsCloseButtons = quizBuilderForm.querySelectorAll("[data-close-quiz-settings]");
  const quizStartUrl = quizBuilderForm.dataset.quizStartUrl || "/quizzes";
  const quizId = quizBuilderForm.dataset.quizId || "";
  const activeSectionInput = quizBuilderForm.querySelector("[data-active-section-input]");
  const activeQuestionInput = quizBuilderForm.querySelector("[data-active-question-input]");
  const resetLiveForm = document.getElementById("quiz-live-reset-form");
  const initialSectionIndex = Number.parseInt(
    quizBuilderForm.dataset.initialSectionIndex || "0",
    10
  );
  const initialQuestionIndex = Number.parseInt(
    quizBuilderForm.dataset.initialQuestionIndex || "0",
    10
  );

  const createChoice = (index, overrides = {}) => ({
    label: overrides.label || `Option ${index}`,
    isCorrect: overrides.isCorrect === undefined ? index === 1 : Boolean(overrides.isCorrect)
  });

  const createQuestion = () => ({
    prompt: "",
    imageUrl: "",
    questionType: "single_choice",
    points: 100,
    timeLimit: 20,
    showLeaderboard: false,
    choices: [
      createChoice(1),
      createChoice(2, { isCorrect: false }),
      createChoice(3, { isCorrect: false }),
      createChoice(4, { isCorrect: false })
    ]
  });

  const createSection = (index) => ({
    title: `Section ${index}`,
    questions: [createQuestion()]
  });

  const normalizeState = (value) => {
    const sections = Array.isArray(value?.sections) ? value.sections : [];

    return {
      sections: sections.length
        ? sections.map((section, sectionIndex) => {
            const questions = Array.isArray(section?.questions) ? section.questions : [];

            return {
              title: String(section?.title || "").trim() || `Section ${sectionIndex + 1}`,
              questions: questions.length
                ? questions.map((question) => ({
                    prompt: String(question?.prompt || ""),
                    imageUrl: String(question?.imageUrl || "").trim(),
                    questionType: ["single_choice", "multiple_choice", "true_false"].includes(
                      question?.questionType
                    )
                      ? question.questionType
                      : "single_choice",
                    points: Number.parseInt(question?.points, 10) || 100,
                    timeLimit: Number.parseInt(question?.timeLimit, 10) || 20,
                    showLeaderboard: Boolean(question?.showLeaderboard),
                    choices: Array.isArray(question?.choices) && question.choices.length
                      ? question.choices.map((choice, choiceIndex) => ({
                          label:
                            String(choice?.label || "").trim() || `Option ${choiceIndex + 1}`,
                          isCorrect: Boolean(choice?.isCorrect)
                        }))
                      : createQuestion().choices
                  }))
                : [createQuestion()]
            };
          })
        : [createSection(1)]
    };
  };

  const parseInitialState = () => {
    try {
      return normalizeState(JSON.parse(quizBuilderDataScript.textContent || "{}"));
    } catch (error) {
      return normalizeState({});
    }
  };

  let state = parseInitialState();
  let activeSectionIndex = Number.isNaN(initialSectionIndex) ? 0 : initialSectionIndex;
  let editingSectionIndex = null;
  let activeQuestionIndexes = [];
  let expandedSectionIndex = activeSectionIndex;
  let sectionMenuIndex = null;
  let questionSettingsOpen = false;

  const setSettingsModalState = (isOpen) => {
    if (!settingsModal) {
      return;
    }

    settingsModal.classList.toggle("is-open", isOpen);
    settingsModal.setAttribute("aria-hidden", String(!isOpen));
    document.body.classList.toggle("modal-open", isOpen);
  };

  const escapeHtml = (value) =>
    String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");

  const readFileAsDataUrl = (file) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("Unable to read that image file."));
      reader.readAsDataURL(file);
    });

  const loadImageElement = (src) =>
    new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Unable to process that image file."));
      image.src = src;
    });

  const processQuestionImageFile = async (file) => {
    if (!file || !String(file.type || "").startsWith("image/")) {
      throw new Error("Choose a valid image file.");
    }

    if (file.size > 10 * 1024 * 1024) {
      throw new Error("Image is too large. Please use a file under 10MB.");
    }

    const originalDataUrl = await readFileAsDataUrl(file);

    if (file.type === "image/svg+xml") {
      return originalDataUrl;
    }

    const image = await loadImageElement(originalDataUrl);
    const maxDimension = 1600;
    const scale = Math.min(1, maxDimension / Math.max(image.width || 1, image.height || 1));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));

    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Unable to prepare that image.");
    }

    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    const optimizedDataUrl = canvas.toDataURL("image/jpeg", 0.82);

    if (optimizedDataUrl.length > 1_600_000) {
      throw new Error("Image is still too large after optimization. Please use a smaller photo.");
    }

    return optimizedDataUrl;
  };

  const ensureSingleCorrectChoice = (question) => {
    const firstCorrectIndex = question.choices.findIndex((choice) => choice.isCorrect);
    const nextCorrectIndex = firstCorrectIndex === -1 ? 0 : firstCorrectIndex;

    question.choices.forEach((choice, index) => {
      choice.isCorrect = index === nextCorrectIndex;
    });
  };

  const ensureMultipleChoiceState = (question) => {
    if (!question.choices.some((choice) => choice.isCorrect) && question.choices.length) {
      question.choices[0].isCorrect = true;
    }
  };

  const setTrueFalseChoices = (question) => {
    const trueChoiceWasCorrect = question.choices.some(
      (choice) => choice.label.toLowerCase() === "true" && choice.isCorrect
    );
    const falseChoiceWasCorrect = question.choices.some(
      (choice) => choice.label.toLowerCase() === "false" && choice.isCorrect
    );

    question.choices = [
      {
        label: "True",
        isCorrect: trueChoiceWasCorrect || (!trueChoiceWasCorrect && !falseChoiceWasCorrect)
      },
      {
        label: "False",
        isCorrect: falseChoiceWasCorrect
      }
    ];

    ensureSingleCorrectChoice(question);
  };

  const syncQuestionRules = (question) => {
    if (question.questionType === "true_false") {
      setTrueFalseChoices(question);
      return;
    }

    if (question.choices.length < 2) {
      question.choices.push(createChoice(question.choices.length + 1, { isCorrect: false }));
    }

    if (question.questionType === "multiple_choice") {
      ensureMultipleChoiceState(question);
      return;
    }

    ensureSingleCorrectChoice(question);
  };

  const ensureState = () => {
    if (!Array.isArray(state.sections) || !state.sections.length) {
      state = { sections: [createSection(1)] };
    }

    state.sections.forEach((section, sectionIndex) => {
      if (!String(section.title || "").trim()) {
        section.title = `Section ${sectionIndex + 1}`;
      }

      if (!Array.isArray(section.questions) || !section.questions.length) {
        section.questions = [createQuestion()];
      }

      section.questions.forEach((question) => {
        if (!Array.isArray(question.choices) || !question.choices.length) {
          question.choices = createQuestion().choices;
        }

        syncQuestionRules(question);
      });
    });

    if (activeSectionIndex > state.sections.length - 1) {
      activeSectionIndex = state.sections.length - 1;
    }

    if (expandedSectionIndex !== null && expandedSectionIndex > state.sections.length - 1) {
      expandedSectionIndex = state.sections.length ? state.sections.length - 1 : null;
    }

    if (sectionMenuIndex !== null && sectionMenuIndex > state.sections.length - 1) {
      sectionMenuIndex = null;
    }
  };

  const syncHiddenState = () => {
    if (hiddenStateInput) {
      hiddenStateInput.value = JSON.stringify({ sections: state.sections });
    }

    if (activeSectionInput) {
      activeSectionInput.value = String(activeSectionIndex);
    }

    if (activeQuestionInput) {
      activeQuestionInput.value = String(activeQuestionIndexes[activeSectionIndex] || 0);
    }
  };

  const ensureQuestionIndexes = () => {
    activeQuestionIndexes = state.sections.map((section, sectionIndex) => {
      const initialIndex =
        sectionIndex === activeSectionIndex && !Number.isNaN(initialQuestionIndex)
          ? initialQuestionIndex
          : 0;
      const currentIndex = Number.parseInt(
        activeQuestionIndexes[sectionIndex] ?? initialIndex,
        10
      );
      const safeIndex = Number.isNaN(currentIndex) ? 0 : currentIndex;
      return Math.max(0, Math.min(safeIndex, section.questions.length - 1));
    });
  };

  const syncLocationState = () => {
    if (!window.history?.replaceState) {
      return;
    }

    const url = new URL(window.location.href);
    url.searchParams.set("section", String(activeSectionIndex + 1));
    url.searchParams.set("question", String((activeQuestionIndexes[activeSectionIndex] || 0) + 1));
    window.history.replaceState({}, "", url.toString());
  };

  const focusSectionTitleInput = (sectionIndex) => {
    const input = quizBuilderForm.querySelector(
      `[data-section-nav-title="${sectionIndex}"]`
    );

    if (!input) {
      return;
    }

    window.setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  };

  const renderSectionNav = () => {
    if (!sectionNav) {
      return;
    }

    sectionNav.innerHTML = state.sections
      .map((section, sectionIndex) => {
        const isActive = sectionIndex === activeSectionIndex;
        const isEditing = sectionIndex === editingSectionIndex;
        const isExpanded = sectionIndex === expandedSectionIndex;
        const isMenuOpen = sectionIndex === sectionMenuIndex;
        const questionCount = section.questions.length;
        const activeQuestionIndex = activeQuestionIndexes[sectionIndex] || 0;
        const questionListMarkup = section.questions
          .map((question, questionIndex) => {
            const questionLabel =
              String(question.prompt || "").trim() ||
              (String(question.imageUrl || "").trim()
                ? `Image question ${questionIndex + 1}`
                : `Untitled question ${questionIndex + 1}`);

            return `
              <button
                type="button"
                class="quiz-section-question-button ${
                  isActive && questionIndex === activeQuestionIndex ? "is-active" : ""
                }"
                data-select-question="${questionIndex}"
                data-section-index="${sectionIndex}"
              >
                <span class="quiz-section-question-number">${questionIndex + 1}</span>
                <span class="quiz-section-question-label">${escapeHtml(questionLabel)}</span>
              </button>
            `;
          })
          .join("");

        return `
          <article class="quiz-section-card ${isActive ? "is-active" : ""}">
            <div
              class="quiz-section-card-main"
              data-section-select="${sectionIndex}"
              role="button"
              tabindex="0"
            >
              <div class="quiz-section-card-top">
                <div class="quiz-section-card-copy">
                  ${
                    isEditing
                      ? `
                        <input
                          type="text"
                          class="quiz-section-nav-title-input"
                          value="${escapeHtml(section.title)}"
                          data-section-nav-title="${sectionIndex}"
                          aria-label="Section title"
                        />
                      `
                      : `
                        <span
                          class="quiz-section-nav-title-text"
                          data-start-section-rename="${sectionIndex}"
                          role="button"
                          tabindex="0"
                        >
                          ${escapeHtml(section.title)}
                        </span>
                      `
                  }
                  <span>${questionCount} question${questionCount === 1 ? "" : "s"}</span>
                </div>

                <button
                  type="button"
                  class="quiz-section-toggle-button ${isExpanded ? "is-open" : ""}"
                  data-toggle-section-questions="${sectionIndex}"
                  aria-label="Toggle question list"
                  aria-expanded="${String(isExpanded)}"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="m6 9 6 6 6-6"></path>
                  </svg>
                </button>
              </div>

              <div class="quiz-section-card-bottom">
                <div class="quiz-section-card-stat">
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M8 4h8v3a4 4 0 0 1-8 0Z"></path>
                    <path d="M6 5H4a2 2 0 0 0 2 5"></path>
                    <path d="M18 5h2a2 2 0 0 1-2 5"></path>
                    <path d="M12 11v4"></path>
                    <path d="M9 19h6"></path>
                    <path d="M10 15h4"></path>
                  </svg>
                  <span>0 participants</span>
                </div>

                <div class="quiz-section-card-actions">
                  <a
                    href="${quizStartUrl}"
                    class="quiz-section-start-button"
                    aria-label="Start quiz"
                    title="Start quiz"
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="m10 8 6 4-6 4Z"></path>
                    </svg>
                  </a>

                  <div class="quiz-section-menu-wrap" data-section-menu-wrap>
                    <button
                      type="button"
                      class="quiz-section-more-button"
                      data-toggle-section-menu="${sectionIndex}"
                      aria-label="Section actions"
                      aria-expanded="${String(isMenuOpen)}"
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <circle cx="12" cy="5" r="1.5"></circle>
                        <circle cx="12" cy="12" r="1.5"></circle>
                        <circle cx="12" cy="19" r="1.5"></circle>
                      </svg>
                    </button>

                    ${
                      isMenuOpen
                        ? `
                          <div class="quiz-section-menu" data-section-menu>
                            ${
                              quizId
                                ? `
                                  <button
                                    type="button"
                                    class="quiz-section-menu-item quiz-section-menu-item-neutral"
                                    data-reset-live-results
                                  >
                                    Reset leaderboard
                                  </button>
                                `
                                : ""
                            }
                            <button
                              type="button"
                              class="quiz-section-menu-item"
                              data-remove-section="${sectionIndex}"
                              ${state.sections.length === 1 ? "disabled" : ""}
                            >
                              Delete section
                            </button>
                          </div>
                        `
                        : ""
                    }
                  </div>
                </div>
              </div>
            </div>

            ${
              isExpanded
                ? `
                  <div class="quiz-section-question-list">
                    ${questionListMarkup}
                  </div>
                `
                : ""
            }
          </article>
        `;
      })
      .join("");
  };

  const buildChoiceMarkup = (question, sectionIndex, questionIndex, choice, choiceIndex) => {
    const correctControlType =
      question.questionType === "multiple_choice" ? "checkbox" : "radio";
    const controlName = `question-correct-${sectionIndex}-${questionIndex}`;

    return `
      <div class="quiz-choice-row">
        <div class="quiz-choice-row-top">
          <label class="quiz-choice-correct" aria-label="Mark correct answer">
            <input
              type="${correctControlType}"
              name="${controlName}"
              data-correct-choice="${choiceIndex}"
              data-section-index="${sectionIndex}"
              data-question-index="${questionIndex}"
              ${choice.isCorrect ? "checked" : ""}
            />
            <span class="quiz-choice-correct-indicator">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="m8.5 12 2.5 2.5 4.5-5"></path>
              </svg>
            </span>
          </label>

          <input
            type="text"
            class="quiz-choice-input"
            value="${escapeHtml(choice.label)}"
            placeholder="Option ${choiceIndex + 1}"
            data-choice-label="${choiceIndex}"
            data-section-index="${sectionIndex}"
            data-question-index="${questionIndex}"
            ${question.questionType === "true_false" ? "readonly" : ""}
          />

          <button
            type="button"
            class="quiz-choice-remove"
            data-remove-choice="${choiceIndex}"
            data-section-index="${sectionIndex}"
            data-question-index="${questionIndex}"
            aria-label="Remove choice"
            ${question.questionType === "true_false" || question.choices.length <= 2 ? "disabled" : ""}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 7h16"></path>
              <path d="M10 11v6"></path>
              <path d="M14 11v6"></path>
              <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"></path>
              <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path>
            </svg>
          </button>
        </div>

        <div class="quiz-choice-progress-row">
          <div class="quiz-choice-progress-bar" aria-hidden="true">
            <span style="width: 0%"></span>
          </div>
          <span class="quiz-choice-progress-value">0%</span>
        </div>
      </div>
    `;
  };

  const renderActiveSection = () => {
    if (!sectionPanels) {
      return;
    }

    const section = state.sections[activeSectionIndex];
    const activeQuestionIndex = activeQuestionIndexes[activeSectionIndex] || 0;

    if (!section) {
      sectionPanels.innerHTML = "";
      return;
    }

    const question = section.questions[activeQuestionIndex];

    if (!question) {
      sectionPanels.innerHTML = "";
      return;
    }

    const choicesMarkup = question.choices
      .map((choice, choiceIndex) =>
        buildChoiceMarkup(question, activeSectionIndex, activeQuestionIndex, choice, choiceIndex)
      )
      .join("");
    const imageMarkup = question.imageUrl
      ? `
          <div class="quiz-question-image-preview">
            <img src="${escapeHtml(question.imageUrl)}" alt="Question image preview" />
          </div>
          <div class="quiz-question-media-actions">
            <button
              type="button"
              class="secondary-button quiz-question-image-remove"
              data-remove-question-image="${activeQuestionIndex}"
              data-section-index="${activeSectionIndex}"
              data-question-index="${activeQuestionIndex}"
            >
              Remove photo
            </button>
          </div>
        `
      : `
          <div class="quiz-question-image-empty">
            <span class="quiz-question-image-empty-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <rect x="3" y="5" width="18" height="14" rx="2"></rect>
                <circle cx="9" cy="10" r="1.5"></circle>
                <path d="m21 15-4.5-4.5L9 18"></path>
              </svg>
            </span>
            <div class="quiz-question-image-empty-copy">
              <strong>No photo added yet</strong>
              <span>Upload JPG, PNG, WEBP, GIF, or SVG. The image will show above the answers during the quiz.</span>
            </div>
          </div>
        `;

    sectionPanels.innerHTML = `
      <section class="quiz-section-editor">
        <article class="quiz-question-card">
          <div class="quiz-question-card-header">
            <div class="quiz-question-card-meta">
              <span class="quiz-question-step">${activeQuestionIndex + 1}</span>
              <div class="quiz-question-card-copy">
                <strong>Quiz question</strong>
                <div class="quiz-question-card-submeta">
                  <span>0 votes</span>
                  <span>&bull;</span>
                  <label class="quiz-question-inline-time">
                    <input
                      type="number"
                      min="5"
                      max="300"
                      value="${question.timeLimit}"
                      data-question-time="${activeQuestionIndex}"
                      data-section-index="${activeSectionIndex}"
                      data-question-index="${activeQuestionIndex}"
                    />
                    <span>sec</span>
                  </label>
                </div>
              </div>
            </div>

            <div class="quiz-question-card-tools">
              <label class="quiz-question-inline-field">
                <span>Type</span>
                <select
                  data-question-type="${activeQuestionIndex}"
                  data-section-index="${activeSectionIndex}"
                  data-question-index="${activeQuestionIndex}"
                >
                  <option value="single_choice" ${question.questionType === "single_choice" ? "selected" : ""}>Single choice</option>
                  <option value="multiple_choice" ${question.questionType === "multiple_choice" ? "selected" : ""}>Multiple choice</option>
                  <option value="true_false" ${question.questionType === "true_false" ? "selected" : ""}>True / False</option>
                </select>
              </label>

              <div class="quiz-question-settings-wrap" data-question-settings-wrap>
                <button
                  type="button"
                  class="quiz-question-action-button"
                  data-toggle-question-settings
                  aria-expanded="${String(questionSettingsOpen)}"
                  aria-label="Question settings"
                  title="Question settings"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M21 6h-6"></path>
                    <path d="M9 6H3"></path>
                    <path d="M21 12h-10"></path>
                    <path d="M5 12H3"></path>
                    <path d="M21 18h-4"></path>
                    <path d="M11 18H3"></path>
                    <circle cx="12" cy="6" r="3"></circle>
                    <circle cx="8" cy="12" r="3"></circle>
                    <circle cx="14" cy="18" r="3"></circle>
                  </svg>
                </button>

                ${
                  questionSettingsOpen
                    ? `
                      <div class="quiz-question-settings-menu">
                        <label class="quiz-question-setting-item">
                          <span class="quiz-question-setting-copy">
                            <strong>Show leaderboard</strong>
                            <span>Reveal the live leaderboard after this question.</span>
                          </span>
                          <span class="quiz-setting-switch">
                            <input
                              type="checkbox"
                              data-question-show-leaderboard="${activeQuestionIndex}"
                              data-section-index="${activeSectionIndex}"
                              data-question-index="${activeQuestionIndex}"
                              ${question.showLeaderboard ? "checked" : ""}
                            />
                            <span class="quiz-setting-slider" aria-hidden="true"></span>
                          </span>
                        </label>
                      </div>
                    `
                    : ""
                }
              </div>

              <button
                type="button"
                class="quiz-remove-question-button"
                data-remove-question="${activeQuestionIndex}"
                data-section-index="${activeSectionIndex}"
                aria-label="Remove question"
                ${section.questions.length === 1 ? "disabled" : ""}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M4 7h16"></path>
                  <path d="M10 11v6"></path>
                  <path d="M14 11v6"></path>
                  <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"></path>
                  <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path>
                </svg>
              </button>
            </div>
          </div>

          <label class="quiz-question-prompt-field">
            <textarea
              rows="2"
              class="quiz-question-prompt-input"
              data-question-prompt="${activeQuestionIndex}"
              data-section-index="${activeSectionIndex}"
              data-question-index="${activeQuestionIndex}"
              placeholder="Type your question"
            >${escapeHtml(question.prompt)}</textarea>
          </label>

          <section class="quiz-question-media-panel">
            <div class="quiz-question-media-header">
              <div class="quiz-question-media-copy">
                <strong>Question image</strong>
                <span>Add a photo when the question depends on a visual reference.</span>
              </div>

              <label class="secondary-button quiz-question-image-trigger">
                <input
                  type="file"
                  accept="image/*"
                  class="quiz-question-image-input"
                  data-question-image-upload="${activeQuestionIndex}"
                  data-section-index="${activeSectionIndex}"
                  data-question-index="${activeQuestionIndex}"
                />
                <span>${question.imageUrl ? "Replace photo" : "Add photo"}</span>
              </label>
            </div>

            ${imageMarkup}
          </section>

          <div class="quiz-choice-list">
            <div class="quiz-choice-stack">
              ${choicesMarkup}
            </div>

            <button
              type="button"
              class="quiz-add-choice-link"
              data-add-choice="${activeQuestionIndex}"
              data-section-index="${activeSectionIndex}"
              ${question.questionType === "true_false" || question.choices.length >= 6 ? "disabled" : ""}
            >
              <span>+</span>
              <span>Add option</span>
            </button>
          </div>
        </article>

        <div class="quiz-section-editor-actions">
          <button
            type="button"
            class="quiz-add-question-button"
            data-add-question="${activeSectionIndex}"
          >
            <span>+</span>
            <span>Add another quiz question</span>
          </button>
        </div>
      </section>
    `;
  };

  const render = () => {
    ensureState();
    ensureQuestionIndexes();
    syncHiddenState();
    syncLocationState();
    renderSectionNav();
    renderActiveSection();
  };

  addSectionButton?.addEventListener("click", () => {
    state.sections.push(createSection(state.sections.length + 1));
    activeSectionIndex = state.sections.length - 1;
    editingSectionIndex = activeSectionIndex;
    expandedSectionIndex = activeSectionIndex;
    sectionMenuIndex = null;
    questionSettingsOpen = false;
    render();
    focusSectionTitleInput(activeSectionIndex);
  });

  quizBuilderForm.addEventListener("click", (event) => {
    const sectionQuestionsToggle = event.target.closest("[data-toggle-section-questions]");
    if (sectionQuestionsToggle) {
      event.stopPropagation();

      const sectionIndex =
        Number.parseInt(sectionQuestionsToggle.dataset.toggleSectionQuestions, 10) || 0;
      activeSectionIndex = sectionIndex;
      expandedSectionIndex = expandedSectionIndex === sectionIndex ? null : sectionIndex;
      sectionMenuIndex = null;
      questionSettingsOpen = false;
      renderSectionNav();
      renderActiveSection();
      return;
    }

    const sectionMenuToggle = event.target.closest("[data-toggle-section-menu]");
    if (sectionMenuToggle) {
      event.stopPropagation();

      const sectionIndex =
        Number.parseInt(sectionMenuToggle.dataset.toggleSectionMenu, 10) || 0;
      sectionMenuIndex = sectionMenuIndex === sectionIndex ? null : sectionIndex;
      questionSettingsOpen = false;
      renderSectionNav();
      return;
    }

    const questionSettingsToggle = event.target.closest("[data-toggle-question-settings]");
    if (questionSettingsToggle) {
      event.stopPropagation();
      questionSettingsOpen = !questionSettingsOpen;
      renderActiveSection();
      return;
    }

    const renameTrigger = event.target.closest("[data-start-section-rename]");
    if (renameTrigger) {
      event.stopPropagation();

      const sectionIndex =
        Number.parseInt(renameTrigger.dataset.startSectionRename, 10) || 0;
      activeSectionIndex = sectionIndex;
      editingSectionIndex = sectionIndex;
      expandedSectionIndex = sectionIndex;
      sectionMenuIndex = null;
      questionSettingsOpen = false;
      render();
      focusSectionTitleInput(sectionIndex);
      return;
    }

    if (event.target.matches("[data-section-nav-title]")) {
      return;
    }

    const sectionSelectButton = event.target.closest("[data-section-select]");
    if (sectionSelectButton && !event.target.closest(".quiz-section-card-actions")) {
      const nextSectionIndex =
        Number.parseInt(sectionSelectButton.dataset.sectionSelect, 10) || 0;

      if (activeSectionIndex !== nextSectionIndex || editingSectionIndex !== null) {
        activeSectionIndex = nextSectionIndex;
        expandedSectionIndex = nextSectionIndex;
        editingSectionIndex = null;
        sectionMenuIndex = null;
        questionSettingsOpen = false;
        render();
      }

      return;
    }

    const selectQuestionButton = event.target.closest("[data-select-question]");
    if (selectQuestionButton) {
      const sectionIndex = Number.parseInt(selectQuestionButton.dataset.sectionIndex, 10) || 0;
      const questionIndex = Number.parseInt(selectQuestionButton.dataset.selectQuestion, 10) || 0;
      activeSectionIndex = sectionIndex;
      activeQuestionIndexes[sectionIndex] = questionIndex;
      expandedSectionIndex = sectionIndex;
      sectionMenuIndex = null;
      questionSettingsOpen = false;
      render();
      return;
    }

    const removeSectionButton = event.target.closest("[data-remove-section]");
    if (removeSectionButton) {
      if (state.sections.length === 1) {
        return;
      }

      const sectionIndex = Number.parseInt(removeSectionButton.dataset.removeSection, 10);
      state.sections.splice(sectionIndex, 1);
      editingSectionIndex = null;
      sectionMenuIndex = null;
      questionSettingsOpen = false;
      activeSectionIndex = Math.max(0, Math.min(activeSectionIndex, state.sections.length - 1));
      expandedSectionIndex = activeSectionIndex;
      render();
      return;
    }

    const resetLiveResultsButton = event.target.closest("[data-reset-live-results]");
    if (resetLiveResultsButton) {
      event.stopPropagation();

      if (!resetLiveForm) {
        return;
      }

      const shouldReset = window.confirm(
        "Reset the saved leaderboard and live session history for this quiz?"
      );

      if (shouldReset) {
        resetLiveForm.submit();
      }
      return;
    }

    const addQuestionButton = event.target.closest("[data-add-question]");
    if (addQuestionButton) {
      const sectionIndex = Number.parseInt(addQuestionButton.dataset.addQuestion, 10) || 0;
      state.sections[sectionIndex].questions.push(createQuestion());
      activeQuestionIndexes[sectionIndex] = state.sections[sectionIndex].questions.length - 1;
      activeSectionIndex = sectionIndex;
      expandedSectionIndex = sectionIndex;
      questionSettingsOpen = false;
      render();
      return;
    }

    const removeQuestionButton = event.target.closest("[data-remove-question]");
    if (removeQuestionButton) {
      const sectionIndex = Number.parseInt(removeQuestionButton.dataset.sectionIndex, 10) || 0;
      const questionIndex = Number.parseInt(removeQuestionButton.dataset.removeQuestion, 10) || 0;
      const section = state.sections[sectionIndex];

      if (section.questions.length === 1) {
        return;
      }

      section.questions.splice(questionIndex, 1);
      activeQuestionIndexes[sectionIndex] = Math.max(
        0,
        Math.min(activeQuestionIndexes[sectionIndex] || 0, section.questions.length - 1)
      );
      activeSectionIndex = sectionIndex;
      expandedSectionIndex = sectionIndex;
      questionSettingsOpen = false;
      render();
      return;
    }

    const addChoiceButton = event.target.closest("[data-add-choice]");
    if (addChoiceButton) {
      const sectionIndex = Number.parseInt(addChoiceButton.dataset.sectionIndex, 10) || 0;
      const questionIndex = Number.parseInt(addChoiceButton.dataset.addChoice, 10) || 0;
      const question = state.sections[sectionIndex].questions[questionIndex];

      if (question.questionType === "true_false" || question.choices.length >= 6) {
        return;
      }

      question.choices.push(
        createChoice(question.choices.length + 1, {
          isCorrect: question.questionType === "multiple_choice" ? false : false
        })
      );
      syncQuestionRules(question);
      render();
      return;
    }

    const removeQuestionImageButton = event.target.closest("[data-remove-question-image]");
    if (removeQuestionImageButton) {
      const sectionIndex = Number.parseInt(removeQuestionImageButton.dataset.sectionIndex, 10) || 0;
      const questionIndex = Number.parseInt(removeQuestionImageButton.dataset.questionIndex, 10) || 0;
      const question = state.sections[sectionIndex]?.questions?.[questionIndex];

      if (!question) {
        return;
      }

      question.imageUrl = "";
      syncHiddenState();
      renderActiveSection();
      return;
    }

    const removeChoiceButton = event.target.closest("[data-remove-choice]");
    if (removeChoiceButton) {
      const sectionIndex = Number.parseInt(removeChoiceButton.dataset.sectionIndex, 10) || 0;
      const questionIndex = Number.parseInt(removeChoiceButton.dataset.questionIndex, 10) || 0;
      const choiceIndex = Number.parseInt(removeChoiceButton.dataset.removeChoice, 10) || 0;
      const question = state.sections[sectionIndex].questions[questionIndex];

      if (question.questionType === "true_false" || question.choices.length <= 2) {
        return;
      }

      question.choices.splice(choiceIndex, 1);
      syncQuestionRules(question);
      render();
    }
  });

  quizBuilderForm.addEventListener("input", (event) => {
    const sectionIndex = Number.parseInt(event.target.dataset.sectionIndex, 10);
    const questionIndex = Number.parseInt(event.target.dataset.questionIndex, 10);

    if (event.target.matches("[data-section-nav-title]")) {
      const nextSectionIndex =
        Number.parseInt(event.target.dataset.sectionNavTitle, 10) || 0;
      state.sections[nextSectionIndex].title = event.target.value;
      syncHiddenState();
      return;
    }

    if (Number.isNaN(sectionIndex) || Number.isNaN(questionIndex)) {
      return;
    }

    const question = state.sections[sectionIndex].questions[questionIndex];

    if (event.target.matches("[data-question-prompt]")) {
      question.prompt = event.target.value;
      syncHiddenState();
      return;
    }

    if (event.target.matches("[data-question-points]")) {
      question.points = Number.parseInt(event.target.value, 10) || 100;
      syncHiddenState();
      return;
    }

    if (event.target.matches("[data-question-time]")) {
      question.timeLimit = Number.parseInt(event.target.value, 10) || 20;
      syncHiddenState();
      return;
    }

    if (event.target.matches("[data-choice-label]")) {
      const choiceIndex = Number.parseInt(event.target.dataset.choiceLabel, 10) || 0;
      question.choices[choiceIndex].label = event.target.value;
      syncHiddenState();
    }
  });

  quizBuilderForm.addEventListener("change", async (event) => {
    const sectionIndex = Number.parseInt(event.target.dataset.sectionIndex, 10);
    const questionIndex = Number.parseInt(event.target.dataset.questionIndex, 10);

    if (event.target.matches("[data-question-image-upload]")) {
      const imageSectionIndex = Number.parseInt(event.target.dataset.sectionIndex, 10) || 0;
      const imageQuestionIndex = Number.parseInt(event.target.dataset.questionIndex, 10) || 0;
      const question = state.sections[imageSectionIndex]?.questions?.[imageQuestionIndex];
      const file = event.target.files?.[0];

      if (!question || !file) {
        event.target.value = "";
        return;
      }

      try {
        question.imageUrl = await processQuestionImageFile(file);
        syncHiddenState();
        renderActiveSection();
      } catch (error) {
        window.alert(error.message);
      } finally {
        event.target.value = "";
      }

      return;
    }

    if (Number.isNaN(sectionIndex) || Number.isNaN(questionIndex)) {
      return;
    }

    const question = state.sections[sectionIndex].questions[questionIndex];

    if (event.target.matches("[data-question-type]")) {
      question.questionType = event.target.value;

      if (question.questionType === "true_false") {
        setTrueFalseChoices(question);
      } else if (question.questionType === "multiple_choice") {
        ensureMultipleChoiceState(question);
      } else {
        ensureSingleCorrectChoice(question);
      }

      render();
      return;
    }

    if (event.target.matches("[data-question-show-leaderboard]")) {
      question.showLeaderboard = event.target.checked;
      syncHiddenState();
      return;
    }

    if (event.target.matches("[data-correct-choice]")) {
      const choiceIndex = Number.parseInt(event.target.dataset.correctChoice, 10) || 0;

      if (question.questionType === "multiple_choice") {
        question.choices[choiceIndex].isCorrect = event.target.checked;
        ensureMultipleChoiceState(question);
      } else {
        question.choices.forEach((choice, index) => {
          choice.isCorrect = index === choiceIndex;
        });
      }

      syncHiddenState();
    }
  });

  quizBuilderForm.addEventListener("focusout", (event) => {
    if (!event.target.matches("[data-section-nav-title]")) {
      return;
    }

    const sectionIndex =
      Number.parseInt(event.target.dataset.sectionNavTitle, 10) || 0;
    const nextTitle = String(event.target.value || "").trim();

    state.sections[sectionIndex].title = nextTitle || `Section ${sectionIndex + 1}`;
    editingSectionIndex = null;
    syncHiddenState();
    renderSectionNav();
  });

  quizBuilderForm.addEventListener("keydown", (event) => {
    if (event.target.matches("[data-section-select]")) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        const nextSectionIndex =
          Number.parseInt(event.target.dataset.sectionSelect, 10) || 0;
        activeSectionIndex = nextSectionIndex;
        editingSectionIndex = null;
        render();
      }

      return;
    }

    if (event.target.matches("[data-start-section-rename]")) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        const sectionIndex =
          Number.parseInt(event.target.dataset.startSectionRename, 10) || 0;
        activeSectionIndex = sectionIndex;
        editingSectionIndex = sectionIndex;
        render();
        focusSectionTitleInput(sectionIndex);
      }

      return;
    }

    if (event.target.matches("[data-section-nav-title]")) {
      if (event.key === "Enter") {
        event.preventDefault();
        event.target.blur();
      }

      if (event.key === "Escape") {
        event.preventDefault();
        const sectionIndex =
          Number.parseInt(event.target.dataset.sectionNavTitle, 10) || 0;
        state.sections[sectionIndex].title =
          String(event.target.value || "").trim() || `Section ${sectionIndex + 1}`;
        editingSectionIndex = null;
        syncHiddenState();
        renderSectionNav();
      }
    }
  });

  if (settingsModal) {
    settingsOpenButtons.forEach((button) => {
      button.addEventListener("click", () => {
        setSettingsModalState(true);
      });
    });

    settingsCloseButtons.forEach((button) => {
      button.addEventListener("click", () => {
        setSettingsModalState(false);
      });
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && settingsModal.classList.contains("is-open")) {
        setSettingsModalState(false);
      }
    });
  }

  document.addEventListener("click", (event) => {
    if (!questionSettingsOpen) {
      return;
    }

    if (event.target.closest("[data-question-settings-wrap]")) {
      return;
    }

    questionSettingsOpen = false;
    renderActiveSection();
  });

  render();
}
