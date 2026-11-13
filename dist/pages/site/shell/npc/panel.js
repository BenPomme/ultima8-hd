// web/npc/panel.js
// Optional chat panel. OFF BY DEFAULT.
//
// When disabled this module renders NOTHING, attaches NO listeners and reads NO
// native state. Enabling it mounts a small form; disabling it removes the DOM it
// created and leaves the game exactly as it was. It never binds a key the game
// uses, and it never synthesises input.
//
// The panel is a thin view over createChatController: all logic (memory,
// transport, option admission) lives in chat.js and stays testable under Node.

import { createChatController, DEFAULT_SETTINGS } from "./chat.js";

export const PANEL_ROOT_ID = "npc-chat-panel";

export function mountPanel(win, controller, options = {}) {
  const doc = win?.document;
  if (!doc || !controller) return null;
  if (controller.getSettings().panelEnabled !== true && options.force !== true) return null; // inert

  let root = doc.getElementById(PANEL_ROOT_ID);
  if (!root) {
    root = doc.createElement("section");
    root.id = PANEL_ROOT_ID;
    root.className = "npc-panel";
    root.setAttribute("aria-label", "NPC conversation");
    (doc.body ?? doc.documentElement).appendChild(root);
  }
  root.textContent = "";

  const log = doc.createElement("div");
  log.className = "npc-panel-log";
  log.setAttribute("aria-live", "polite");

  const form = doc.createElement("form");
  form.className = "npc-panel-form";
  const input = doc.createElement("input");
  input.type = "text";
  input.className = "npc-panel-input";
  input.setAttribute("data-test", "npc-input");
  input.placeholder = "Say something…";
  const send = doc.createElement("button");
  send.type = "submit";
  send.setAttribute("data-test", "npc-send");
  send.textContent = "Speak";
  form.append(input, send);

  const controls = doc.createElement("div");
  controls.className = "npc-panel-controls";

  const newGame = doc.createElement("button");
  newGame.type = "button";
  newGame.setAttribute("data-test", "npc-new-playthrough");
  newGame.textContent = "New playthrough";

  const forgetOne = doc.createElement("button");
  forgetOne.type = "button";
  forgetOne.setAttribute("data-test", "npc-forget-one");
  forgetOne.textContent = "Forget this NPC";

  const forgetAll = doc.createElement("button");
  forgetAll.type = "button";
  forgetAll.setAttribute("data-test", "npc-forget-all");
  forgetAll.textContent = "Forget all NPC memory for this playthrough";

  const tts = doc.createElement("button");
  tts.type = "button";
  tts.setAttribute("data-test", "npc-tts-toggle");
  const paintTts = () => { tts.textContent = controller.getSettings().ttsEnabled ? "Read aloud: on" : "Read aloud: off"; };
  paintTts();

  controls.append(newGame, forgetOne, forgetAll, tts);

  const note = doc.createElement("p");
  note.className = "npc-panel-note";
  note.textContent = "NPC memory is kept for this playthrough in your browser. A new playthrough starts fresh.";

  function line(who, text) {
    const p = doc.createElement("p");
    p.className = `npc-line npc-line-${who}`;
    p.dataset.kind = who;
    p.textContent = text;
    log.appendChild(p);
    if (typeof log.scrollTop === "number") log.scrollTop = log.scrollHeight;
  }

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const text = String(input.value ?? "").trim();
    if (!text) return;
    input.value = "";
    line("player", text);
    const res = await controller.ask(text, options);
    log.dataset.lastKind = res.kind ?? "";
    log.dataset.lastError = String(res.error ?? "");
    if (!res.ok) {
      const why = res.message ?? `That didn't work (${res.kind ?? "error"}${res.error ? `: ${res.error}` : ""}).`;
      const p = line("error", why);
      return;
    }
    line("npc", res.reply);
    if (res.applied && res.applied.ok === false) line("error", `(option not applied) ${res.applied.error}`);
  });

  newGame.addEventListener("click", () => { controller.newGame(); line("system", "New playthrough started; NPC memory is empty."); });
  forgetOne.addEventListener("click", () => { controller.forgetCurrentNpc(); line("system", "Memory of this NPC cleared."); });
  forgetAll.addEventListener("click", () => { controller.forgetAllForPlaythrough(); line("system", "All NPC memory for this playthrough cleared."); });
  tts.addEventListener("click", () => { controller.setSettings({ ttsEnabled: !controller.getSettings().ttsEnabled }); paintTts(); });

  root.append(log, form, controls, note);
  return { root, line, unmount: () => { root.remove(); } };
}

// Unmount: remove the panel and stop any speech it started.
export function unmountPanel(win, controller) {
  const doc = win?.document;
  try { controller?.speaker?.cancel?.(); } catch { /* ignore */ }
  const root = doc?.getElementById?.(PANEL_ROOT_ID);
  if (root) root.remove();
}

export { createChatController, DEFAULT_SETTINGS };
