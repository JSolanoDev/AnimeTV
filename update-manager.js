const ANIMETV_VERSION = "1.3.0";
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UPDATE_CHECK_KEY = "animetv-last-update-check";
const UPDATE_SETTINGS_KEYS = [
  "anime-tv-favorites",
  "animetv-language-preferences",
  "animetv-custom-sources",
  "animetv-source-overrides",
  "animetv-watch-history",
  "animetv-resume-positions",
  "animetv-app-language",
  "animetv-app-theme",
  "animetv-ui-preferences",
  "animetv-anime1v-api-key"
];

class UpdateManager {
  constructor(options = {}) {
    this.currentVersion = options.currentVersion || ANIMETV_VERSION;
    this.checkUrl = options.checkUrl || "/api/check-update";
    this.applyUrl = options.applyUrl || "/api/apply-update";
  }

  start() {
    this.checkForUpdates();
    window.setInterval(() => this.checkForUpdates(), UPDATE_CHECK_INTERVAL_MS);
  }

  async checkForUpdates(force = false) {
    const lastCheck = Number(localStorage.getItem(UPDATE_CHECK_KEY) || 0);
    if (!force && Date.now() - lastCheck < UPDATE_CHECK_INTERVAL_MS) return null;
    localStorage.setItem(UPDATE_CHECK_KEY, String(Date.now()));
    try {
      const response = await fetch(this.checkUrl, { cache: "no-store" });
      if (!response.ok) throw new Error(`Update check failed: HTTP ${response.status}`);
      const data = await response.json();
      if (data.updateAvailable) this.showUpdateNotification(data);
      return data;
    } catch (error) {
      console.warn("ZenkaiTV update check failed:", error);
      return null;
    }
  }

  preserveSettings() {
    const backup = {};
    UPDATE_SETTINGS_KEYS.forEach((key) => {
      const value = localStorage.getItem(key);
      if (value !== null) backup[key] = value;
    });
    localStorage.setItem("animetv-update-settings-backup", JSON.stringify(backup));
    return backup;
  }

  restoreSettings(backup = null) {
    const settings = backup || JSON.parse(localStorage.getItem("animetv-update-settings-backup") || "{}");
    Object.entries(settings).forEach(([key, value]) => localStorage.setItem(key, value));
  }

  async downloadUpdate(manifest) {
    return manifest;
  }

  async applyUpdate(manifest) {
    const backup = this.preserveSettings();
    const response = await fetch(this.applyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ manifest, preservedSettings: backup })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      this.rollback(backup);
      throw new Error(data.error || "Update failed and was rolled back.");
    }
    this.restoreSettings(backup);
    return data;
  }

  rollback(backup = null) {
    this.restoreSettings(backup);
    navigator.serviceWorker?.controller?.postMessage({ type: "CLEAR_CACHE" });
  }

  showUpdateNotification(data) {
    document.querySelector(".update-banner")?.remove();
    const banner = document.createElement("div");
    banner.className = "update-banner";
    banner.innerHTML = `
      <span>New version ${this.escape(data.latestVersion || data.version || "")} available.</span>
      <button class="focusable" type="button" data-update-now>Update Now</button>
      <button class="focusable" type="button" data-update-later>Later</button>
      <button class="focusable" type="button" data-update-notes>Release Notes</button>
    `;
    document.body.appendChild(banner);
    banner.querySelector("[data-update-later]")?.addEventListener("click", () => banner.remove());
    banner.querySelector("[data-update-notes]")?.addEventListener("click", () => {
      alert(data.releaseNotes || "No release notes were provided.");
    });
    banner.querySelector("[data-update-now]")?.addEventListener("click", async () => {
      banner.classList.add("is-loading");
      try {
        await this.applyUpdate(await this.downloadUpdate(data.manifest || data));
        banner.querySelector("span").textContent = "Update applied. Restarting ZenkaiTV...";
        window.setTimeout(() => location.reload(), 900);
      } catch (error) {
        banner.classList.remove("is-loading");
        banner.querySelector("span").textContent = error.message;
      }
    });
  }

  escape(value) {
    return String(value || "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#039;"
    }[char]));
  }
}

window.UpdateManager = UpdateManager;
