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
let flashAlpha = 0;

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
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
  shakeTime = SHAKE_DURATION;
  flashAlpha = 0.55;
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
}

function resize() {
  const rect = canvas.getBoundingClientRect();
  width = rect.width;
  height = rect.height;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

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
  if (state === "gameover") {
    resetGame();
    return;
  }
  const { x, y } = pointFromEvent(event);
  if (withinSwapButton(x, y)) {
    player.hue = otherHue(player.hue);
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
  announcer.textContent = `Game over. Final score ${score}.`;
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
      spawnMatchEffect(obstacle);
      continue; // same-hue match: absorbed, removed from play
    }
    if (obstacle.y - obstacle.radius <= height) {
      survivors.push(obstacle);
    }
  }
  obstacles = survivors;
  score = Math.floor(elapsedSeconds * 10) + matchedCount * 15;
}

function draw() {
  const shakeStrength = shakeTime > 0 ? (shakeTime / SHAKE_DURATION) * SHAKE_MAGNITUDE : 0;
  const shakeX = shakeStrength ? (Math.random() * 2 - 1) * shakeStrength : 0;
  const shakeY = shakeStrength ? (Math.random() * 2 - 1) * shakeStrength : 0;

  ctx.save();
  ctx.translate(shakeX, shakeY);

  // A low-alpha clear leaves a fading trail instead of a hard wipe; skipped
  // under prefers-reduced-motion, where every frame gets a full flat clear
  // exactly as before this effect existed.
  ctx.fillStyle = prefersReducedMotion ? "#171b2e" : "rgba(23, 27, 46, 0.28)";
  ctx.fillRect(-16, -16, width + 32, height + 32);

  for (const ring of rings) {
    const t = ring.age / ring.maxAge;
    ctx.beginPath();
    ctx.lineWidth = 3;
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
    ctx.beginPath();
    ctx.fillStyle = HUE_COLOR[obstacle.hue];
    ctx.arc(obstacle.x, obstacle.y, obstacle.radius, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.beginPath();
  ctx.fillStyle = HUE_COLOR[player.hue];
  ctx.arc(player.x, player.y, player.radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#f5f5f7";
  ctx.stroke();

  const pulse = prefersReducedMotion ? 0 : Math.sin(elapsedSeconds * 4) * 2;
  ctx.beginPath();
  ctx.fillStyle = HUE_COLOR[otherHue(player.hue)];
  ctx.arc(swapButton.x, swapButton.y, swapButton.radius + pulse, 0, Math.PI * 2);
  ctx.fill();
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = "#f5f5f7";
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.restore();

  if (flashAlpha > 0) {
    ctx.fillStyle = `rgba(245, 245, 247, ${flashAlpha})`;
    ctx.fillRect(0, 0, width, height);
  }

  ctx.fillStyle = "#f5f5f7";
  ctx.font = "16px system-ui, sans-serif";
  ctx.fillText(`Score: ${score}`, 12, 24);

  if (state === "gameover") {
    ctx.fillStyle = "rgba(15, 18, 32, 0.75)";
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#f5f5f7";
    ctx.textAlign = "center";
    ctx.font = "bold 28px system-ui, sans-serif";
    ctx.fillText("Game over", width / 2, height / 2 - 16);
    ctx.font = "18px system-ui, sans-serif";
    ctx.fillText(`Score: ${score}`, width / 2, height / 2 + 16);
    ctx.fillText("↻", width / 2, height / 2 + 56);
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
