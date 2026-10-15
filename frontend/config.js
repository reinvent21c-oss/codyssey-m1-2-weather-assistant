// Public backend URL only. Never put API keys or Firebase credentials here.
// Keep local development on the local API; static hosting uses the Render origin.
window.APP_CONFIG = Object.freeze({
  API_BASE_URL: ["localhost", "127.0.0.1"].includes(window.location.hostname)
    ? "http://127.0.0.1:8000"
    : "https://codyssey-m1-2-weather-assistant.onrender.com",
});
