"use strict";

// Only local navigation. Each document replaces the previous page's DOM.
document.querySelectorAll(".pl-jump").forEach((form) => {
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const select = form.querySelector("select");
    if (select.value) window.location.assign(select.value);
  });
});

document.addEventListener("keydown", (event) => {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
      event.target.closest("input,textarea,select,button,[contenteditable]")) return;
  const relation = event.key === "ArrowLeft" ? "prev" :
    event.key === "ArrowRight" ? "next" : null;
  if (!relation) return;
  const link = document.querySelector(`a[rel="${relation}"]`);
  if (link) {
    event.preventDefault();
    window.location.assign(link.href);
  }
});
