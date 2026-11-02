(function () {
  var SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  var MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
  var root = document.documentElement;
  var saved = localStorage.getItem("ps-theme");
  if (saved) root.dataset.theme = saved;
  function current() {
    return root.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  }
  function paint() {
    var b = document.getElementById("themeBtn");
    if (b) b.innerHTML = current() === "dark" ? SUN : MOON;
  }
  document.addEventListener("DOMContentLoaded", function () {
    paint();
    document.getElementById("themeBtn").addEventListener("click", function () {
      var next = current() === "dark" ? "light" : "dark";
      root.dataset.theme = next;
      localStorage.setItem("ps-theme", next);
      paint();
    });
  });
})();
