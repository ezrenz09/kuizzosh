const sidebarToggle = document.querySelector("[data-sidebar-toggle]");
const createModal = document.querySelector("[data-create-modal]");
const transferModal = document.querySelector("[data-transfer-modal]");
const actionToggleButtons = document.querySelectorAll("[data-row-action-toggle]");
const detailRows = document.querySelectorAll("[data-detail-row]");
const copyCodeButtons = document.querySelectorAll("[data-copy-code]");
const copyLinkButtons = document.querySelectorAll("[data-copy-link]");
const transferOpenButtons = document.querySelectorAll("[data-open-transfer-modal]");
const transferCloseButtons = document.querySelectorAll("[data-close-transfer-modal]");
const transferForm = document.querySelector("[data-transfer-form]");
const transferEmailInput = document.querySelector("[data-transfer-email]");
const viewSwitchers = document.querySelectorAll("[data-view-switcher]");
const moduleItemLinks = document.querySelectorAll("[data-item-url]");

const closeAllDetailRows = () => {
  detailRows.forEach((row) => {
    row.hidden = true;
    row.classList.remove("is-open");
  });

  actionToggleButtons.forEach((button) => {
    button.setAttribute("aria-expanded", "false");
  });
};

if (sidebarToggle) {
  const collapsedClass = "sidebar-collapsed";
  const storageKey = "kuizzosh-sidebar-collapsed";

  if (window.localStorage.getItem(storageKey) === "true") {
    document.body.classList.add(collapsedClass);
  }

  sidebarToggle.addEventListener("click", () => {
    document.body.classList.toggle(collapsedClass);
    window.localStorage.setItem(
      storageKey,
      String(document.body.classList.contains(collapsedClass))
    );
  });
}

if (createModal) {
  const openButtons = document.querySelectorAll("[data-open-create-modal]");
  const closeButtons = document.querySelectorAll("[data-close-create-modal]");
  const firstInput = createModal.querySelector('input[name="title"]');
  const openClass = "is-open";
  const bodyClass = "modal-open";

  const setModalState = (isOpen) => {
    createModal.classList.toggle(openClass, isOpen);
    createModal.setAttribute("aria-hidden", String(!isOpen));
    document.body.classList.toggle(bodyClass, isOpen);

    if (isOpen && firstInput) {
      window.setTimeout(() => {
        firstInput.focus();
      }, 20);
    }
  };

  if (createModal.dataset.open === "true") {
    setModalState(true);
  }

  openButtons.forEach((button) => {
    button.addEventListener("click", () => {
      setModalState(true);
    });
  });

  closeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      setModalState(false);
    });
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && createModal.classList.contains(openClass)) {
      setModalState(false);
    }
  });
}

if (transferModal && transferForm && transferEmailInput) {
  const openClass = "is-open";
  const bodyClass = "modal-open";

  const setTransferModalState = (isOpen) => {
    transferModal.classList.toggle(openClass, isOpen);
    transferModal.setAttribute("aria-hidden", String(!isOpen));
    document.body.classList.toggle(bodyClass, isOpen);

    if (isOpen) {
      window.setTimeout(() => {
        transferEmailInput.focus();
      }, 20);
    }
  };

  transferOpenButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const itemId = button.dataset.transferId;

      if (!itemId) {
        return;
      }

      transferForm.action = `/kuizzosh/${itemId}/transfer`;
      transferEmailInput.value = "";
      setTransferModalState(true);
    });
  });

  transferCloseButtons.forEach((button) => {
    button.addEventListener("click", () => {
      setTransferModalState(false);
    });
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && transferModal.classList.contains(openClass)) {
      setTransferModalState(false);
    }
  });
}

if (actionToggleButtons.length && detailRows.length) {
  actionToggleButtons.forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();

      const targetId = button.dataset.targetId;
      const targetRow = targetId ? document.getElementById(targetId) : null;
      const isOpen = button.getAttribute("aria-expanded") === "true";

      closeAllDetailRows();

      if (!targetRow || isOpen) {
        return;
      }

      targetRow.hidden = false;
      targetRow.classList.add("is-open");
      button.setAttribute("aria-expanded", "true");
    });
  });

  document.addEventListener("click", (event) => {
    if (
      event.target.closest("[data-row-action-toggle]") ||
      event.target.closest("[data-detail-panel]")
    ) {
      return;
    }

    closeAllDetailRows();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeAllDetailRows();
    }
  });
}

if (viewSwitchers.length) {
  viewSwitchers.forEach((switcher) => {
    const buttons = switcher.querySelectorAll("[data-view-button]");
    const viewContainer = switcher.closest(".module-list-section") || document;
    const panels = viewContainer.querySelectorAll("[data-view-panel]");
    const availableViews = new Set(
      Array.from(buttons).map((button) => button.dataset.viewTarget).filter(Boolean)
    );
    const storageKey = switcher.dataset.storageKey || "";
    const defaultView = switcher.dataset.defaultView || "grid";

    const setView = (viewName) => {
      const nextView = availableViews.has(viewName) ? viewName : defaultView;

      buttons.forEach((button) => {
        const isActive = button.dataset.viewTarget === nextView;
        button.classList.toggle("is-active", isActive);
        button.setAttribute("aria-pressed", String(isActive));
      });

      panels.forEach((panel) => {
        panel.hidden = panel.dataset.viewPanel !== nextView;
      });

      closeAllDetailRows();

      if (storageKey) {
        window.localStorage.setItem(storageKey, nextView);
      }
    };

    let initialView = defaultView;

    if (storageKey) {
      const savedView = window.localStorage.getItem(storageKey);
      if (savedView && availableViews.has(savedView)) {
        initialView = savedView;
      }
    }

    setView(initialView);

    buttons.forEach((button) => {
      button.addEventListener("click", () => {
        setView(button.dataset.viewTarget || defaultView);
      });
    });
  });
}

if (copyCodeButtons.length) {
  const fallbackCopyText = (value) => {
    const tempInput = document.createElement("input");
    tempInput.value = value;
    document.body.appendChild(tempInput);
    tempInput.select();
    document.execCommand("copy");
    tempInput.remove();
  };

  copyCodeButtons.forEach((button) => {
    button.addEventListener("click", async () => {
      const originalLabel = button.getAttribute("aria-label") || "Copy quiz code";
      const originalTitle = button.getAttribute("title") || originalLabel;
      const quizCode = button.dataset.copyCode || "";

      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(quizCode);
        } else {
          fallbackCopyText(quizCode);
        }

        button.classList.add("is-copied");
        button.setAttribute("aria-label", "Copied");
        button.setAttribute("title", "Copied");
      } catch (error) {
        button.setAttribute("aria-label", "Copy failed");
        button.setAttribute("title", "Copy failed");
      }

      window.setTimeout(() => {
        button.classList.remove("is-copied");
        button.setAttribute("aria-label", originalLabel);
        button.setAttribute("title", originalTitle);
      }, 1200);
    });
  });
}

if (copyLinkButtons.length) {
  const fallbackCopyText = (value) => {
    const tempInput = document.createElement("input");
    tempInput.value = value;
    document.body.appendChild(tempInput);
    tempInput.select();
    document.execCommand("copy");
    tempInput.remove();
  };

  copyLinkButtons.forEach((button) => {
    button.addEventListener("click", async () => {
      const originalLabel = button.getAttribute("aria-label") || "Copy Kuizzosh link";
      const originalTitle = button.getAttribute("title") || originalLabel;
      const path = button.dataset.copyLink || "";
      const fullLink = `${window.location.origin}${path}`;

      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(fullLink);
        } else {
          fallbackCopyText(fullLink);
        }

        button.classList.add("is-copied");
        button.setAttribute("aria-label", "Link copied");
        button.setAttribute("title", "Link copied");
      } catch (error) {
        button.setAttribute("aria-label", "Copy failed");
        button.setAttribute("title", "Copy failed");
      }

      window.setTimeout(() => {
        button.classList.remove("is-copied");
        button.setAttribute("aria-label", originalLabel);
        button.setAttribute("title", originalTitle);
      }, 1200);
    });
  });
}

if (moduleItemLinks.length) {
  const openInteractiveSelector = [
    "a",
    "button",
    "input",
    "select",
    "textarea",
    "label",
    "form",
    "[data-detail-panel]",
    "[data-detail-row]"
  ].join(", ");

  moduleItemLinks.forEach((item) => {
    const targetUrl = item.dataset.itemUrl;

    if (!targetUrl) {
      return;
    }

    item.addEventListener("click", (event) => {
      if (event.target.closest(openInteractiveSelector)) {
        return;
      }

      window.location.href = targetUrl;
    });

    item.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }

      event.preventDefault();
      window.location.href = targetUrl;
    });
  });
}
