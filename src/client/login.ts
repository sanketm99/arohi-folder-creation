/** Shows the reason a sign-in attempt failed, passed back as ?error=… */
const message = new URLSearchParams(window.location.search).get("error");
if (message) {
  const box = document.getElementById("loginError");
  if (box) {
    box.textContent = message;
    box.hidden = false;
  }
  // Keep the address bar clean so a refresh does not show the error again.
  window.history.replaceState(null, "", window.location.pathname);
}
