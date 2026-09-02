import {
  circlesOverlap,
  fallSpeed,
  isFatalCollision,
  otherHue,
  spawnIntervalMs,
  type Hue,
  type Obstacle,
  type Player,
} from "./game-logic.ts";

const canvas = document.querySelector<HTMLCanvasElement>("#game")!;
const announcer = document.querySelector<HTMLElement>("#announcer")!;
const ctx = canvas.getContext("2d")!;

// Sky blue / amber, not the teal/pink first tried: a Machado-2009 CVD
// simulation showed teal and pink collapse to near-identical greys under
// deuteranopia (RGB distance ~27, versus ~222 for typical vision) — this
// pair keeps strong separation under protanopia, deuteranopia and
// tritanopia alike, and both halves contrast near-equally against the
// canvas background.
const HUE_COLOR: Record<Hue, string> = { a: "#38bdf8", b: "#f59e0b" };
const FIRST_SPAWN_DELAY_MS = 1200;
const MOVE_SPEED = 340; // px/s, keyboard movement
const MAX_DT = 0.05; // clamp so a backgrounded tab can't leap the sim forward
const SHAKE_DURATION = 0.35;
const SHAKE_MAGNITUDE = 10;

// Score only moves on a match — no more passive time-based trickle. Go
// quiet for STARVE_GRACE_SECONDS and it starts bleeding DECAY_AMOUNT every
// DECAY_INTERVAL until the next match resets the clock, so coasting between
// obstacles costs you instead of paying for itself.
const MATCH_SCORE_GAIN = 15;
const STARVE_GRACE_SECONDS = 2.5;
const DECAY_INTERVAL = 0.4;
const DECAY_AMOUNT = 3;
const SCORE_FLASH_DURATION = 0.3;

// Persisted across runs so a streak's payoff outlives the tab it was earned
// in — the decay/milestone system above only made a single run legible, not
// whether this run was better than the last one.
const BEST_SCORE_KEY = "two-tone-best-score";
function loadBestScore(): number {
  const raw = Number(localStorage.getItem(BEST_SCORE_KEY));
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

// Escalating milestones at a run's 5th/10th match, then every 20 after —
// deliberately in the same two hues as everything else rather than a
// rainbow, so the CVD-safe palette chosen for the core mechanic (see
// HUE_COLOR below) stays the only palette in play.
interface StreakTier {
  rings: number;
  particles: number;
  shakeDuration: number;
  shakeMagnitude: number;
  flash: number;
  glow: number;
  label: string;
}
function streakTier(count: number): StreakTier | null {
  if (count === 5) {
    return { rings: 2, particles: 24, shakeDuration: 0.2, shakeMagnitude: 4, flash: 0.28, glow: 0, label: "5x" };
  }
  if (count === 10) {
    return {
      rings: 3,
      particles: 44,
      shakeDuration: 0.3,
      shakeMagnitude: 7,
      flash: 0.42,
      glow: 1.4,
      label: "10x!",
    };
  }
  if (count >= 20 && count % 20 === 0) {
    return {
      rings: 5,
      particles: 70,
      shakeDuration: 0.45,
      shakeMagnitude: 12,
      flash: 0.6,
      glow: 2.6,
      label: `${count}x STREAK!`,
    };
  }
  return null;
}

const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  hue: Hue;
  radius: number;
  age: number;
  maxAge: number;
}

interface Ring {
  x: number;
  y: number;
  hue: Hue;
  age: number;
  maxAge: number;
  maxRadius: number;
  lineWidth?: number;
}

interface Milestone {
  text: string;
  hue: Hue;
  age: number;
  maxAge: number;
}

interface ScorePopup {
  text: string;
  color: string;
  offsetX: number;
  age: number;
  maxAge: number;
}

interface Star {
  x: number;
  y: number;
  radius: number;
  speed: number;
  alpha: number;
}

// The base clear color drifts from the resting navy toward a deeper violet
// as a run goes on, echoing the fall-speed ramp in game-logic.ts without
// touching the two foreground hues the CVD choice above depends on.
const BACKGROUND_FROM: [number, number, number] = [23, 27, 46];
const BACKGROUND_TO: [number, number, number] = [36, 21, 54];
const BACKGROUND_RAMP_SECONDS = 90;

function backgroundColor(elapsed: number): [number, number, number] {
  const t = Math.min(elapsed / BACKGROUND_RAMP_SECONDS, 1);
  return [0, 1, 2].map((i) => BACKGROUND_FROM[i] + (BACKGROUND_TO[i] - BACKGROUND_FROM[i]) * t) as [
    number,
    number,
    number,
  ];
}

let width = 0;
let height = 0;
let player: Player;
let swapButton: { x: number; y: number; radius: number };
let obstacles: Obstacle[] = [];
let state: "playing" | "gameover" = "playing";
let elapsedSeconds = 0;
let matchedCount = 0;
let score = 0;
let spawnTimer = FIRST_SPAWN_DELAY_MS;
let lastTime: number | null = null;
let draggingPointerId: number | null = null;
const pressed = new Set<string>();
let particles: Particle[] = [];
let rings: Ring[] = [];
let shakeTime = 0;
let shakeMaxTime = SHAKE_DURATION;
let shakeMagnitude = SHAKE_MAGNITUDE;
let flashAlpha = 0;
let milestone: Milestone | null = null;
let playerGlowTime = 0;
let timeSinceMatch = 0;
let decayTimer = 0;
let scorePopups: ScorePopup[] = [];
let scoreFlashTime = 0;
let scoreFlashSign: 1 | -1 = 1;
let bestScore = loadBestScore();
let isNewBest = false;
let stars: Star[] = [];
let vignette: CanvasGradient | null = null;

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// A radial gradient with an off-center hot spot reads as a lit orb instead
// of a flat swatch, without changing the hue itself — the CVD contrast the
// palette above was chosen for survives since the gradient stays within the
// same hue at every stop.
function orbFill(x: number, y: number, radius: number, hue: Hue): CanvasGradient {
  const gradient = ctx.createRadialGradient(x - radius * 0.3, y - radius * 0.35, radius * 0.05, x, y, radius);
  gradient.addColorStop(0, hexToRgba("#ffffff", 0.6));
  gradient.addColorStop(0.45, HUE_COLOR[hue]);
  gradient.addColorStop(1, hexToRgba(HUE_COLOR[hue], 0.85));
  return gradient;
}

// Synthesized rather than sourced from audio files, so the game stays a
// couple of TypeScript modules with no binary assets to license or fetch.
// The AudioContext is created lazily on the first pointerdown/keydown,
// since browsers block audio until a user gesture; mute is a plain click
// toggle, persisted so it survives a refresh.
const MUTED_KEY = "two-tone-muted";
let audioCtx: AudioContext | null = null;
let muted = localStorage.getItem(MUTED_KEY) === "1";
let muteButton: { x: number; y: number; radius: number };

function ensureAudio() {
  if (audioCtx) {
    if (audioCtx.state === "suspended") void audioCtx.resume();
    return;
  }
  const AudioContextClass = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  audioCtx = new AudioContextClass();
}

function toggleMute() {
  muted = !muted;
  localStorage.setItem(MUTED_KEY, muted ? "1" : "0");
}

function withinMuteButton(x: number, y: number): boolean {
  const dx = x - muteButton.x;
  const dy = y - muteButton.y;
  return dx * dx + dy * dy < (muteButton.radius + 10) ** 2;
}

function playTone(
  freq: number,
  duration: number,
  options: { type?: OscillatorType; gain?: number; slideTo?: number; delay?: number } = {},
) {
  if (muted || !audioCtx) return;
  const { type = "sine", gain = 0.14, slideTo, delay = 0 } = options;
  const start = audioCtx.currentTime + delay;
  const osc = audioCtx.createOscillator();
  const gainNode = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, start + duration);
  // Linear attack then exponential decay avoids the click a hard on/off
  // edge makes on a raw oscillator.
  gainNode.gain.setValueAtTime(0.0001, start);
  gainNode.gain.linearRampToValueAtTime(gain, start + 0.012);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(gainNode);
  gainNode.connect(audioCtx.destination);
  osc.start(start);
  osc.stop(start + duration + 0.02);
}

// Pitch climbs a little with the streak so matching feels like it's
// building toward something, capped so it doesn't screech at a long run.
function playMatchSound(streak: number) {
  playTone(420 + Math.min(streak, 24) * 9, 0.14, { type: "sine", gain: 0.13, slideTo: 620 });
}

function playDeathSound() {
  playTone(200, 0.4, { type: "sawtooth", gain: 0.18, slideTo: 55 });
}

function playSwapSound() {
  playTone(700, 0.05, { type: "square", gain: 0.05 });
}

// A short rising arpeggio, one extra note per tier, instead of a single
// tone — gives the 20x milestone a bigger musical moment than the 5x one
// without a separate sound design per tier.
function playStreakSound(tierRings: number) {
  const notes = [660, 880, 990, 1180, 1320];
  for (let i = 0; i < Math.min(tierRings + 1, notes.length); i++) {
    playTone(notes[i], 0.16, { type: "triangle", gain: 0.11, delay: i * 0.07 });
  }
}

function playDecaySound() {
  playTone(180, 0.09, { type: "sine", gain: 0.05, slideTo: 130 });
}

// Decorative only: a player with prefers-reduced-motion gets the same
// instant clear and flat game-over screen as before these effects existed,
// same guard the swap-button pulse already uses below.
function spawnMatchEffect(obstacle: Obstacle) {
  if (prefersReducedMotion) return;
  rings.push({
    x: obstacle.x,
    y: obstacle.y,
    hue: obstacle.hue,
    age: 0,
    maxAge: 0.4,
    maxRadius: obstacle.radius * 2.4,
  });
  spawnParticles(obstacle.x, obstacle.y, obstacle.hue, 10, 0.45, 130);
}

function spawnDeathEffect(x: number, y: number, hue: Hue) {
  if (prefersReducedMotion) return;
  spawnParticles(x, y, hue, 26, 0.7, 220);
  triggerShake(SHAKE_DURATION, SHAKE_MAGNITUDE);
  flashAlpha = 0.55;
}

function triggerShake(duration: number, magnitude: number) {
  shakeTime = duration;
  shakeMaxTime = duration;
  shakeMagnitude = magnitude;
}

// A milestone match (5th, 10th, then every 20th) layers a bigger, two-hue
// version of the ordinary match effect on top of it: concentric rings
// instead of one, particles in both hues instead of one, a stronger
// shake/flash, and — from the 10-streak on — a pulsing aura around the
// player that lingers after the burst fades.
function spawnStreakEffect(count: number, x: number, y: number, hue: Hue) {
  const tier = streakTier(count);
  if (!tier) return;
  playStreakSound(tier.rings);
  if (prefersReducedMotion) return;

  for (let i = 0; i < tier.rings; i++) {
    rings.push({
      x,
      y,
      hue: i % 2 === 0 ? "a" : "b",
      age: 0,
      maxAge: 0.5 + i * 0.15,
      maxRadius: 60 + i * 50 + count,
      lineWidth: Math.max(1.5, 4 - i * 0.5),
    });
  }
  spawnParticles(x, y, "a", Math.ceil(tier.particles / 2), 0.8, 260);
  spawnParticles(x, y, "b", Math.floor(tier.particles / 2), 0.8, 260);

  triggerShake(tier.shakeDuration, tier.shakeMagnitude);
  flashAlpha = Math.max(flashAlpha, tier.flash);
  playerGlowTime = Math.max(playerGlowTime, tier.glow);
  milestone = { text: tier.label, hue, age: 0, maxAge: 1.1 };
}

// A gain popup is colored by the obstacle just eaten, tying it back to the
// hue that earned it; a loss popup stays neutral grey rather than reaching
// for red, since red/green is exactly the axis the CVD palette above was
// chosen to avoid.
function spawnScorePopup(amount: number, hue?: Hue) {
  scoreFlashTime = SCORE_FLASH_DURATION;
  scoreFlashSign = amount > 0 ? 1 : -1;
  if (prefersReducedMotion) return;
  scorePopups.push({
    text: amount > 0 ? `+${amount}` : `${amount}`,
    color: hue ? HUE_COLOR[hue] : "#8b90a8",
    offsetX: Math.random() * 10 - 5,
    age: 0,
    maxAge: 0.9,
  });
}

function spawnParticles(x: number, y: number, hue: Hue, count: number, maxAge: number, speed: number) {
  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i) / count + Math.random() * 0.6;
    const velocity = speed * (0.5 + Math.random() * 0.5);
    particles.push({
      x,
      y,
      vx: Math.cos(angle) * velocity,
      vy: Math.sin(angle) * velocity,
      hue,
      radius: 3 + Math.random() * 3,
      age: 0,
      maxAge,
    });
  }
}

function updateEffects(dt: number) {
  if (!prefersReducedMotion) {
    for (const star of stars) {
      star.y += star.speed * dt;
      if (star.y > height) {
        star.y = -2;
        star.x = Math.random() * width;
      }
    }
  }

  for (const particle of particles) {
    particle.age += dt;
    particle.x += particle.vx * dt;
    particle.y += particle.vy * dt;
    particle.vx *= 0.94;
    particle.vy *= 0.94;
  }
  particles = particles.filter((particle) => particle.age < particle.maxAge);

  for (const ring of rings) ring.age += dt;
  rings = rings.filter((ring) => ring.age < ring.maxAge);

  if (shakeTime > 0) shakeTime = Math.max(0, shakeTime - dt);
  if (flashAlpha > 0) flashAlpha = Math.max(0, flashAlpha - dt * 2.2);
  if (playerGlowTime > 0) playerGlowTime = Math.max(0, playerGlowTime - dt);

  if (milestone) {
    milestone.age += dt;
    if (milestone.age >= milestone.maxAge) milestone = null;
  }

  for (const popup of scorePopups) popup.age += dt;
  scorePopups = scorePopups.filter((popup) => popup.age < popup.maxAge);

  if (scoreFlashTime > 0) scoreFlashTime = Math.max(0, scoreFlashTime - dt);
}

function initStars() {
  const count = Math.round((width * height) / 9000);
  stars = Array.from({ length: count }, () => ({
    x: Math.random() * width,
    y: Math.random() * height,
    radius: Math.random() * 1.3 + 0.4,
    speed: 8 + Math.random() * 18,
    alpha: 0.15 + Math.random() * 0.35,
  }));
}

function resize() {
  const rect = canvas.getBoundingClientRect();
  width = rect.width;
  height = rect.height;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  initStars();
  // A soft dark ring at the edges gives the play field depth without
  // touching either foreground hue; cached here since width/height only
  // change on resize, not every frame.
  vignette = ctx.createRadialGradient(
    width / 2,
    height / 2,
    Math.min(width, height) * 0.4,
    width / 2,
    height / 2,
    Math.max(width, height) * 0.75,
  );
  vignette.addColorStop(0, "rgba(0, 0, 0, 0)");
  vignette.addColorStop(1, "rgba(0, 0, 0, 0.45)");

  const radius = clamp(width * 0.045, 14, 24);
  if (!player) {
    player = { x: width / 2, y: 0, radius, hue: "a" };
  } else {
    player.radius = radius;
    player.x = clamp(player.x, radius, width - radius);
  }
  player.y = height - radius - 24;
  // Top-right, clear of the player's row: sharing the bottom corner with the
  // swap button let a resize clamp the player right on top of it, muddling
  // which circle was "you" — found by playing at the mobile viewport.
  swapButton = { x: width - 34, y: 34, radius: 20 };
  // Left of the swap button with a clear gap between the two hit targets.
  muteButton = { x: width - 76, y: 34, radius: 13 };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function resetGame() {
  obstacles = [];
  state = "playing";
  elapsedSeconds = 0;
  matchedCount = 0;
  score = 0;
  spawnTimer = FIRST_SPAWN_DELAY_MS;
  player.hue = "a";
  player.x = width / 2;
  announcer.textContent = "";
  particles = [];
  rings = [];
  shakeTime = 0;
  flashAlpha = 0;
  milestone = null;
  playerGlowTime = 0;
  timeSinceMatch = 0;
  decayTimer = 0;
  scorePopups = [];
  scoreFlashTime = 0;
  isNewBest = false;
}

function spawnObstacle() {
  const radius = clamp(width * 0.045, 14, 24);
  const hue: Hue = Math.random() < 0.5 ? "a" : "b";
  obstacles.push({
    x: clamp(Math.random() * width, radius, width - radius),
    y: -radius,
    radius,
    hue,
  });
}

function pointFromEvent(event: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function withinSwapButton(x: number, y: number): boolean {
  const dx = x - swapButton.x;
  const dy = y - swapButton.y;
  return dx * dx + dy * dy < (swapButton.radius + 12) ** 2;
}

canvas.addEventListener("pointerdown", (event) => {
  canvas.focus();
  ensureAudio();
  const { x, y } = pointFromEvent(event);
  // Checked before the gameover branch below so muting on the game-over
  // screen toggles sound instead of restarting the round.
  if (withinMuteButton(x, y)) {
    toggleMute();
    return;
  }
  if (state === "gameover") {
    resetGame();
    return;
  }
  if (withinSwapButton(x, y)) {
    player.hue = otherHue(player.hue);
    playSwapSound();
    return;
  }
  // Keyed by pointerId, not a shared flag: an incidental second touch (a
  // palm edge, a bracing finger) lifting off must not stop the pointer
  // that's actually dragging --- found by simulating two independent
  // pointer identities and watching the first one's still-held drag go
  // unresponsive the instant the second one released.
  if (draggingPointerId !== null) return;
  draggingPointerId = event.pointerId;
  canvas.setPointerCapture(event.pointerId);
  player.x = clamp(x, player.radius, width - player.radius);
});

canvas.addEventListener("pointermove", (event) => {
  if (event.pointerId !== draggingPointerId) return;
  const { x } = pointFromEvent(event);
  player.x = clamp(x, player.radius, width - player.radius);
});

function endDrag(event: PointerEvent) {
  if (event.pointerId !== draggingPointerId) return;
  draggingPointerId = null;
  if (canvas.hasPointerCapture(event.pointerId)) {
    canvas.releasePointerCapture(event.pointerId);
  }
}
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);

window.addEventListener("keydown", (event) => {
  // Space, the arrow keys, Home, End, PageUp and PageDown are all browser
  // scroll keys and the game has no use for any of them, so all six are
  // suppressed unconditionally here rather than only inside the branches
  // below --- Home/End/PageUp/PageDown scrolled the page during ordinary
  // play the same way ArrowUp/ArrowDown once did, confirmed live at a real
  // short viewport, since none of the four has an in-game effect that would
  // otherwise call preventDefault() on them.
  if (
    event.key === " " ||
    event.key === "Spacebar" ||
    event.key === "ArrowUp" ||
    event.key === "ArrowDown" ||
    event.key === "Home" ||
    event.key === "End" ||
    event.key === "PageUp" ||
    event.key === "PageDown"
  ) {
    event.preventDefault();
  }
  ensureAudio();
  // Checked before the gameover branch below, same reasoning as the mute
  // button's pointerdown check: muting mid-game-over shouldn't restart it.
  if (event.key === "m" || event.key === "M") {
    if (event.repeat) return;
    toggleMute();
    return;
  }
  if (state === "gameover") {
    // A key held down at the moment of a fatal collision --- the likely case,
    // since dying usually happens mid-dodge --- keeps sending repeat keydowns
    // for as long as it stays physically held. Restarting on those wipes the
    // game-over screen before the player ever sees it; only a genuine fresh
    // keydown (a release-and-repress, or a different key) should restart.
    if (event.repeat) return;
    resetGame();
    return;
  }
  if (event.key === "ArrowLeft" || event.key === "a" || event.key === "A") {
    pressed.add("left");
    event.preventDefault();
  } else if (event.key === "ArrowRight" || event.key === "d" || event.key === "D") {
    pressed.add("right");
    event.preventDefault();
  } else if (event.key === " " || event.key === "Spacebar") {
    // A toggle, not a hold: the browser's own key auto-repeat would otherwise
    // keep flipping the hue for as long as Space stays physically held, the
    // same repeat-vs-fresh-press distinction already guarded on gameover
    // restart above.
    if (event.repeat) return;
    player.hue = otherHue(player.hue);
    playSwapSound();
  }
});

window.addEventListener("keyup", (event) => {
  if (event.key === "ArrowLeft" || event.key === "a" || event.key === "A") pressed.delete("left");
  if (event.key === "ArrowRight" || event.key === "d" || event.key === "D") pressed.delete("right");
});

// A key held down while the tab loses focus never gets its keyup — clear
// held state so the player doesn't drift on refocus. blur alone misses a
// same-window tab switch (the browser window keeps OS focus, so it never
// blurs, but the document does still hide); visibilitychange catches that
// case too.
function releaseHeldInput() {
  pressed.clear();
  draggingPointerId = null;
}
window.addEventListener("blur", releaseHeldInput);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) releaseHeldInput();
});

function gameOver(obstacle: Obstacle) {
  state = "gameover";
  // A collision mid-drag leaves the pointer still down with no pointerup to
  // clear it --- without this, pointermove keeps sliding the player under
  // the game-over overlay, found by forcing the collision mid-drag and
  // watching playerX keep tracking the pointer after the round had ended.
  draggingPointerId = null;
  spawnDeathEffect(player.x, player.y, obstacle.hue);
  playDeathSound();
  isNewBest = score > bestScore;
  if (isNewBest) {
    bestScore = score;
    localStorage.setItem(BEST_SCORE_KEY, String(bestScore));
  }
  announcer.textContent = isNewBest
    ? `Game over. Final score ${score}. New best!`
    : `Game over. Final score ${score}. Best ${bestScore}.`;
}

function update(dt: number) {
  elapsedSeconds += dt;

  if (draggingPointerId === null) {
    const dir = (pressed.has("right") ? 1 : 0) - (pressed.has("left") ? 1 : 0);
    player.x = clamp(player.x + dir * MOVE_SPEED * dt, player.radius, width - player.radius);
  }

  spawnTimer -= dt * 1000;
  if (spawnTimer <= 0) {
    spawnObstacle();
    spawnTimer = spawnIntervalMs(elapsedSeconds);
  }

  const speed = fallSpeed(elapsedSeconds);
  const survivors: Obstacle[] = [];
  for (const obstacle of obstacles) {
    obstacle.y += speed * dt;

    if (isFatalCollision(player, obstacle)) {
      gameOver(obstacle);
      survivors.push(obstacle);
      continue;
    }
    if (circlesOverlap(player, obstacle)) {
      matchedCount += 1;
      score += MATCH_SCORE_GAIN;
      timeSinceMatch = 0;
      decayTimer = 0;
      spawnScorePopup(MATCH_SCORE_GAIN, obstacle.hue);
      spawnMatchEffect(obstacle);
      playMatchSound(matchedCount);
      spawnStreakEffect(matchedCount, obstacle.x, obstacle.y, obstacle.hue);
      continue; // same-hue match: absorbed, removed from play
    }
    if (obstacle.y - obstacle.radius <= height) {
      survivors.push(obstacle);
    }
  }
  obstacles = survivors;

  timeSinceMatch += dt;
  if (timeSinceMatch > STARVE_GRACE_SECONDS && score > 0) {
    decayTimer += dt;
    while (decayTimer >= DECAY_INTERVAL && score > 0) {
      decayTimer -= DECAY_INTERVAL;
      const amount = Math.min(DECAY_AMOUNT, score);
      score -= amount;
      spawnScorePopup(-amount);
      playDecaySound();
    }
  }
}

function draw() {
  const shakeStrength = shakeTime > 0 ? (shakeTime / shakeMaxTime) * shakeMagnitude : 0;
  const shakeX = shakeStrength ? (Math.random() * 2 - 1) * shakeStrength : 0;
  const shakeY = shakeStrength ? (Math.random() * 2 - 1) * shakeStrength : 0;

  ctx.save();
  ctx.translate(shakeX, shakeY);

  // A low-alpha clear leaves a fading trail instead of a hard wipe; skipped
  // under prefers-reduced-motion, where every frame gets a full flat clear
  // exactly as before this effect existed. The base color itself drifts
  // toward violet as the run goes on (see backgroundColor above).
  const [bgR, bgG, bgB] = backgroundColor(elapsedSeconds);
  ctx.fillStyle = prefersReducedMotion
    ? `rgb(${bgR}, ${bgG}, ${bgB})`
    : `rgba(${bgR}, ${bgG}, ${bgB}, 0.28)`;
  ctx.fillRect(-16, -16, width + 32, height + 32);

  for (const star of stars) {
    ctx.beginPath();
    ctx.fillStyle = `rgba(245, 245, 247, ${star.alpha})`;
    ctx.arc(star.x, star.y, star.radius, 0, Math.PI * 2);
    ctx.fill();
  }

  for (const ring of rings) {
    const t = ring.age / ring.maxAge;
    ctx.beginPath();
    ctx.lineWidth = ring.lineWidth ?? 3;
    ctx.strokeStyle = hexToRgba(HUE_COLOR[ring.hue], 1 - t);
    ctx.arc(ring.x, ring.y, ring.maxRadius * t, 0, Math.PI * 2);
    ctx.stroke();
  }

  for (const particle of particles) {
    const t = particle.age / particle.maxAge;
    ctx.beginPath();
    ctx.fillStyle = hexToRgba(HUE_COLOR[particle.hue], 1 - t);
    ctx.arc(particle.x, particle.y, particle.radius * (1 - t * 0.5), 0, Math.PI * 2);
    ctx.fill();
  }

  for (const obstacle of obstacles) {
    ctx.save();
    ctx.shadowColor = HUE_COLOR[obstacle.hue];
    ctx.shadowBlur = obstacle.radius * 0.8;
    ctx.beginPath();
    ctx.fillStyle = orbFill(obstacle.x, obstacle.y, obstacle.radius, obstacle.hue);
    ctx.arc(obstacle.x, obstacle.y, obstacle.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  if (playerGlowTime > 0) {
    const glowAlpha = Math.min(1, playerGlowTime / 1.4) * 0.5;
    const glowRadius = player.radius + 8 + Math.sin(elapsedSeconds * 6) * 3;
    ctx.beginPath();
    ctx.lineWidth = 4;
    ctx.strokeStyle = hexToRgba(HUE_COLOR[otherHue(player.hue)], glowAlpha);
    ctx.arc(player.x, player.y, glowRadius, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.save();
  ctx.shadowColor = HUE_COLOR[player.hue];
  ctx.shadowBlur = player.radius * 0.9;
  ctx.beginPath();
  ctx.fillStyle = orbFill(player.x, player.y, player.radius, player.hue);
  ctx.arc(player.x, player.y, player.radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#f5f5f7";
  ctx.stroke();

  const pulse = prefersReducedMotion ? 0 : Math.sin(elapsedSeconds * 4) * 2;
  ctx.save();
  ctx.shadowColor = HUE_COLOR[otherHue(player.hue)];
  ctx.shadowBlur = 10;
  ctx.beginPath();
  ctx.fillStyle = orbFill(swapButton.x, swapButton.y, swapButton.radius + pulse, otherHue(player.hue));
  ctx.arc(swapButton.x, swapButton.y, swapButton.radius + pulse, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = "#f5f5f7";
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.restore();

  if (vignette) {
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, width, height);
  }

  // Drawn in screen space, outside the shake transform above, so muting
  // mid-shake doesn't make the hit target jump around under the cursor.
  ctx.textAlign = "center";
  ctx.font = "16px system-ui, sans-serif";
  ctx.fillStyle = "rgba(245, 245, 247, 0.85)";
  ctx.fillText(muted ? "🔇" : "🔊", muteButton.x, muteButton.y + 6);
  ctx.textAlign = "left";

  if (flashAlpha > 0) {
    ctx.fillStyle = `rgba(245, 245, 247, ${flashAlpha})`;
    ctx.fillRect(0, 0, width, height);
  }

  if (milestone) {
    const t = milestone.age / milestone.maxAge;
    // Quick pop in (first 15% of the lifetime), lingering hold, slow fade —
    // the scale-down-from-1.6x sells the "pop" more than a fade-in alone.
    const introT = Math.min(t / 0.15, 1);
    const alpha = t < 0.15 ? introT : 1 - (t - 0.15) / 0.85;
    const scale = 1 + (1 - introT) * 0.6;
    ctx.save();
    ctx.translate(width / 2, height / 2 - 40);
    ctx.scale(scale, scale);
    ctx.textAlign = "center";
    ctx.font = "bold 40px system-ui, sans-serif";
    ctx.fillStyle = hexToRgba(HUE_COLOR[milestone.hue], Math.max(0, Math.min(1, alpha)));
    ctx.fillText(milestone.text, 0, 0);
    ctx.restore();
  }

  // A gain pops the score text white and slightly larger; a loss dims it
  // toward grey instead of red, for the same red/green reason a loss popup
  // stays grey below rather than reaching for a "danger" color.
  const scoreFlashT = scoreFlashTime / SCORE_FLASH_DURATION;
  const scoreScale = prefersReducedMotion ? 1 : 1 + scoreFlashT * 0.35;
  const scoreColor = scoreFlashTime > 0 ? (scoreFlashSign > 0 ? "#ffffff" : "#8b90a8") : "#f5f5f7";
  ctx.font = "16px system-ui, sans-serif";
  const scoreText = `Score: ${score}`;
  const scoreWidth = ctx.measureText(scoreText).width;
  ctx.save();
  ctx.translate(12, 24);
  ctx.scale(scoreScale, scoreScale);
  ctx.fillStyle = scoreColor;
  ctx.textAlign = "left";
  ctx.fillText(scoreText, 0, 0);
  ctx.restore();

  for (const popup of scorePopups) {
    const t = popup.age / popup.maxAge;
    ctx.fillStyle = hexToRgba(popup.color, 1 - t);
    ctx.font = "bold 15px system-ui, sans-serif";
    ctx.fillText(popup.text, 12 + scoreWidth + 18 + popup.offsetX, 24 - t * 30);
  }

  ctx.font = "13px system-ui, sans-serif";
  ctx.fillStyle = "#8b90a8";
  ctx.fillText(`Best: ${bestScore}`, 12, 44);

  if (state === "gameover") {
    ctx.fillStyle = "rgba(15, 18, 32, 0.75)";
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#f5f5f7";
    ctx.textAlign = "center";
    ctx.font = "bold 28px system-ui, sans-serif";
    ctx.fillText("Game over", width / 2, height / 2 - 16);
    ctx.font = "18px system-ui, sans-serif";
    ctx.fillText(`Score: ${score}`, width / 2, height / 2 + 16);
    if (isNewBest) {
      ctx.fillStyle = HUE_COLOR[player.hue];
      ctx.font = "bold 16px system-ui, sans-serif";
      ctx.fillText("New best!", width / 2, height / 2 + 40);
    } else {
      ctx.fillStyle = "#8b90a8";
      ctx.font = "16px system-ui, sans-serif";
      ctx.fillText(`Best: ${bestScore}`, width / 2, height / 2 + 40);
    }
    ctx.fillStyle = "#f5f5f7";
    ctx.font = "18px system-ui, sans-serif";
    ctx.fillText("↻", width / 2, height / 2 + 72);
    ctx.textAlign = "left";
  }
}

function loop(timestamp: number) {
  if (lastTime === null) lastTime = timestamp;
  const dt = Math.min((timestamp - lastTime) / 1000, MAX_DT);
  lastTime = timestamp;

  if (state === "playing") {
    update(dt);
  }
  updateEffects(dt);
  draw();
  requestAnimationFrame(loop);
}

resize();
window.addEventListener("resize", resize);
requestAnimationFrame(loop);
