// Closes the top nav's "More" dropdown on an outside click or Escape.
// The dropdown itself is a plain <details>, so it still works without this.
(function () {
  var more = document.querySelector(".nav-more");
  if (!more) return;
  document.addEventListener("click", function (e) {
    if (more.open && !more.contains(e.target)) more.open = false;
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && more.open) {
      more.open = false;
      more.querySelector("summary").focus();
    }
  });
})();
