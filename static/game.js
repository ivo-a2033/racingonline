const CAR_CONFIG = {
    driveForce: 0.08,
    boostForce: 0.04,
    maxSpeed: 80,
    boostMaxSpeed: 100,
    maxLateralImpulse: 1,
    angularDampingPerFrame: 0.90,
    forwardDrag: 0.002,
    maxTurnRate: 0.07,
    steeringLockToLockSeconds: 0.25,
    accelerationResponseSeconds: 0.18,
    minimumSteeringSpeed: 0.5,
    maxRearTurnForceBoost: 0.02
};

const GAUGE_CONFIG = {
    accelerationMax: 1,
    speedMax: 40,
    arcDegrees: 300,
    radius: 96,
    combinedRadius: 124,
    combinedInnerRadius: 96
};

const AUDIO_CONFIG = {
    engineSound: 'muted',
    lowPassFrequency: 1000
};

const REAR_TUNING = {
    density: { atZero: 0.015, atOne: 0.005 },
    friction: { atZero: 0.008, atOne: 0.08 },
    frictionAir: { atZero: 0.003, atOne: 0.03 }
};

const ROAD_TURN_AVERAGE_SEGMENTS = 12;
const ROAD_FULL_BLUE_TURN_RADIANS = 0.04;
const TRACK_TEXTURE_SIZE = 512;
const TRACK_ROAD_HALF_WIDTH = 290;
const TRACK_ROAD_WIDTH = TRACK_ROAD_HALF_WIDTH * 2;
const TRACK_STRIP_WIDTH = 60;
const TRACK_STRIPE_INTERVAL = 30;
const PICKUP_CONFIG = {
    rectangles: [
           { width: 48, height: 48, color: 0x00b83f, rotationSpeed: 2.4 },
           { width: 88, height: 88, color: 0x00e84a, rotationSpeed: -1.6 },
           { width: 132, height: 132, color: 0x39ff14, rotationSpeed: 0.9 }
    ]
};
const PICKUP_AUDIO_KEYS = ['pickup-2'];

const config = {
    type: Phaser.AUTO,
    width: 800,
    height: 800,
    backgroundColor: '#a5a5d3',
    physics: {
        default: 'matter',
        matter: {
            gravity: { y: 0 },
            debug: false,
            debugBodyColor: 0x00ff88,
            debugWireframes: true
        }
    },
    scene: {
        preload: preload,
        create: create,
        update: update
    }
};

const game = new Phaser.Game(config);

let carFront, carRear;
let cursors, wasd;
let zoom = 0.8;
let skidMarks = [];
let lastRearLeft = null;
let lastRearRight = null;
let socket;
const ghosts = {};
const playerId = Math.random().toString(36).slice(2);
const worldsize = 20000;
const TRACK_START = { x: worldsize * 0.3, y: worldsize * 0.3 };
let enginePhase = 0;
let engineRev = 0;
let engineFilterState = 0;
let rearTuningAmount = 0;
let accelerationAmount = 0;
let boostAmount = 0;
let gaugeMode = 'split';

function preload() {
    this.load.image('car', '/car.png');
    this.load.audio('pickup-2', '/audio/pickup-coin-2.wav');
    this.load.audio('pickup-3', '/audio/pickup-coin-3.wav');
    this.load.audio('pickup-4', '/audio/pickup-coin-4.wav');
}

function createTrack(scene) {
    const centerX = worldsize / 2;
    const centerY = worldsize / 2;
    const startAngle = Math.atan2(TRACK_START.y - centerY, TRACK_START.x - centerX);
    const startRadius = Math.hypot(TRACK_START.x - centerX, TRACK_START.y - centerY);
    const bendScale = startRadius / Math.hypot(1000 - centerX, 1000 - centerY);
    const margin = 600;
    const bends = [
        { frequency: 3, cosine: 3650 + Math.random() * 250, sine: 500 + Math.random() * 300 },
        { frequency: 5, cosine: 450 + Math.random() * 250, sine: 350 + Math.random() * 250 },
        { frequency: 7, cosine: 300 + Math.random() * 200, sine: 1250 + Math.random() * 200 },
        { frequency: 11, cosine: 180 + Math.random() * 160, sine: 150 + Math.random() * 150 }
    ];
    const points = [];
    const divisions = 720;

    for (let i = 0; i < divisions; i++) {
        const angle = i / divisions * Math.PI * 2;
        const offset = angle - startAngle;
        let radius = startRadius;
        for (const bend of bends) {
            radius += (bend.cosine * (Math.cos(bend.frequency * offset) - 1)
                + bend.sine * Math.sin(bend.frequency * offset)) * bendScale;
        }

        const dx = Math.cos(angle);
        const dy = Math.sin(angle);
        let maxRadius = 20000;
        if (dx > 0) maxRadius = Math.min(maxRadius, (worldsize - margin - centerX) / dx);
        if (dx < 0) maxRadius = Math.min(maxRadius, (margin - centerX) / dx);
        if (dy > 0) maxRadius = Math.min(maxRadius, (worldsize - margin - centerY) / dy);
        if (dy < 0) maxRadius = Math.min(maxRadius, (margin - centerY) / dy);
        radius = Phaser.Math.Clamp(radius, 500, maxRadius);

        points.push({
            x: centerX + dx * radius,
            y: centerY + dy * radius
        });
    }

    const segmentTurnFactors = points.map((point, i) => {
        const next = points[(i + 1) % points.length];
        const afterNext = points[(i + 2) % points.length];
        const firstX = next.x - point.x;
        const firstY = next.y - point.y;
        const secondX = afterNext.x - next.x;
        const secondY = afterNext.y - next.y;
        const cross = firstX * secondY - firstY * secondX;
        const dot = firstX * secondX + firstY * secondY;
        const turn = Math.atan2(cross, dot);
        return Phaser.Math.Clamp(turn / ROAD_FULL_BLUE_TURN_RADIANS, -1, 1);
    });
    const averageSegments = Phaser.Math.Clamp(
        Math.floor(ROAD_TURN_AVERAGE_SEGMENTS),
        1,
        points.length
    );
    const segments = points.map((start, i) => {
        let turnFactor = 0;
        for (let offset = 0; offset < averageSegments; offset++) {
            turnFactor += segmentTurnFactors[(i + offset) % points.length];
        }
        turnFactor /= averageSegments;

        const end = points[(i + 1) % points.length];
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const length = Math.hypot(dx, dy);
        const turnStrength = Math.abs(turnFactor);
        const red = Math.round(255 + (40 - 255) * turnStrength);
        const greenTarget = turnFactor < 0 ? 255 : 123;
        const blueTarget = turnFactor < 0 ? 40 : 255;
        const green = Math.round(48 + (greenTarget - 48) * turnStrength);
        const blue = Math.round(48 + (blueTarget - 48) * turnStrength);

        return {
            start,
            end,
            dx,
            dy,
            length,
            midpointX: (start.x + end.x) / 2,
            midpointY: (start.y + end.y) / 2,
            color: Phaser.Display.Color.GetColor(red, green, blue)
        };
    });

    const tiles = new Map();
    for (const segment of segments) {
        const minTileX = Math.floor((Math.min(segment.start.x, segment.end.x)
            - TRACK_ROAD_HALF_WIDTH) / TRACK_TEXTURE_SIZE);
        const maxTileX = Math.floor((Math.max(segment.start.x, segment.end.x)
            + TRACK_ROAD_HALF_WIDTH) / TRACK_TEXTURE_SIZE);
        const minTileY = Math.floor((Math.min(segment.start.y, segment.end.y)
            - TRACK_ROAD_HALF_WIDTH) / TRACK_TEXTURE_SIZE);
        const maxTileY = Math.floor((Math.max(segment.start.y, segment.end.y)
            + TRACK_ROAD_HALF_WIDTH) / TRACK_TEXTURE_SIZE);

        for (let tileY = minTileY; tileY <= maxTileY; tileY++) {
            for (let tileX = minTileX; tileX <= maxTileX; tileX++) {
                tiles.set(`${tileX},${tileY}`, { x: tileX, y: tileY });
            }
        }
    }

    const track = scene.add.graphics();
    let tileIndex = 0;
    for (const tile of tiles.values()) {
        const tileX = tile.x * TRACK_TEXTURE_SIZE;
        const tileY = tile.y * TRACK_TEXTURE_SIZE;
        const minX = tileX - TRACK_ROAD_HALF_WIDTH;
        const maxX = tileX + TRACK_TEXTURE_SIZE + TRACK_ROAD_HALF_WIDTH;
        const minY = tileY - TRACK_ROAD_HALF_WIDTH;
        const maxY = tileY + TRACK_TEXTURE_SIZE + TRACK_ROAD_HALF_WIDTH;
        const intersectsTile = (x1, y1, x2, y2, padding = 0) =>
            Math.max(x1, x2) + padding >= minX
            && Math.min(x1, x2) - padding <= maxX
            && Math.max(y1, y2) + padding >= minY
            && Math.min(y1, y2) - padding <= maxY;

        track.clear();
        track.lineStyle(TRACK_ROAD_WIDTH, 0x252530, 1);
        for (const segment of segments) {
            if (intersectsTile(segment.start.x, segment.start.y, segment.end.x, segment.end.y, 20)) {
                const overshootX = segment.dx / segment.length * 20;
                const overshootY = segment.dy / segment.length * 20;
                track.lineBetween(
                    segment.start.x - overshootX - tileX,
                    segment.start.y - overshootY - tileY,
                    segment.end.x + overshootX - tileX,
                    segment.end.y + overshootY - tileY
                );
            }
        }

        track.lineStyle(140, 0x555566, 1);
        for (const segment of segments) {
            if (intersectsTile(segment.start.x, segment.start.y, segment.end.x, segment.end.y)) {
                track.lineBetween(
                    segment.start.x - tileX,
                    segment.start.y - tileY,
                    segment.end.x - tileX,
                    segment.end.y - tileY
                );
            }
        }

        track.lineStyle(9, 0xd8d2a8, 0.8);
        for (let i = 0; i < points.length; i += TRACK_STRIPE_INTERVAL) {
            const start = points[i];
            const end = points[(i + 5) % points.length];
            if (intersectsTile(start.x, start.y, end.x, end.y, 6)) {
                track.lineBetween(
                    start.x - tileX,
                    start.y - tileY,
                    end.x - tileX,
                    end.y - tileY
                );
            }
        }

        for (const segment of segments) {
            if (!intersectsTile(
                segment.start.x,
                segment.start.y,
                segment.end.x,
                segment.end.y,
                TRACK_STRIP_WIDTH / 2 + 20
            )) {
                continue;
            }

            track.lineStyle(TRACK_STRIP_WIDTH + 40, segment.color, 0.6);
            const halfLaneWidth = 70;
            track.lineBetween(
                segment.midpointX - segment.dy / segment.length * halfLaneWidth - tileX,
                segment.midpointY + segment.dx / segment.length * halfLaneWidth - tileY,
                segment.midpointX + segment.dy / segment.length * halfLaneWidth - tileX,
                segment.midpointY - segment.dx / segment.length * halfLaneWidth - tileY
            );
        }

        const textureKey = `track-tile-${tileIndex++}`;
        track.generateTexture(textureKey, TRACK_TEXTURE_SIZE, TRACK_TEXTURE_SIZE);
        scene.add.image(
            tileX + TRACK_TEXTURE_SIZE / 2,
            tileY + TRACK_TEXTURE_SIZE / 2,
            textureKey
        ).setDepth(-1);
    }
    track.destroy();
    const stripePositions = points.filter((point, index) => index % TRACK_STRIPE_INTERVAL === 0);
    const closestStripeIndex = stripePositions.reduce((closestIndex, position, index) => {
        const closestPosition = stripePositions[closestIndex];
        return Math.hypot(position.x - TRACK_START.x, position.y - TRACK_START.y)
            < Math.hypot(closestPosition.x - TRACK_START.x, closestPosition.y - TRACK_START.y)
            ? index
            : closestIndex;
    }, 0);
    const firstPositionIndex = (closestStripeIndex - 2 + stripePositions.length)
        % stripePositions.length;
    return stripePositions.map((_, offset) =>
        stripePositions[(firstPositionIndex + offset) % stripePositions.length]
    );
}

function spawnNextPickup(scene) {
    const position = scene.trackStripePositions[scene.nextPickupPositionIndex];
    scene.nextPickupPositionIndex = (scene.nextPickupPositionIndex + 1)
        % scene.trackStripePositions.length;
    scene.pickupRectangles.forEach(rectangle => {
        rectangle.setPosition(position.x, position.y).setRotation(0).setVisible(true);
    });
}

function makeEngineBuffer(ctx, rev, duration = 0.02) {
    const sampleRate = ctx.sampleRate;
    const length = Math.floor(sampleRate * duration);
    const buffer = ctx.createBuffer(1, length, sampleRate);
    const samples = buffer.getChannelData(0);
    const baseFreq = 220 + rev * 200;
    const filterAmount = 1 - Math.exp(-2 * Math.PI * 1800 / sampleRate);

    // Fade in/out duration in samples (~2ms)
    const fadeSamples = Math.floor(sampleRate * 0.002);

    for (let i = 0; i < length; i++) {
        const noise = Math.random() * 2 - 1;
        const cyclePhase = enginePhase % 1;
        const buzzPulse = 0.7 * (2 * cyclePhase - 1)
            + 0.3 * Math.sin(4 * Math.PI * enginePhase);
        const classicPulse = Math.sin(2 * Math.PI * enginePhase)
            + 0.35 * Math.sin(3 * Math.PI * enginePhase);
        const pulse = AUDIO_CONFIG.engineSound === 'buzzsaw'
            ? buzzPulse
            : AUDIO_CONFIG.engineSound === 'combined'
                ? (buzzPulse + classicPulse) * 0.5
                : classicPulse;
        const subRumble = Math.sin(Math.PI * enginePhase);
        
        let sample = AUDIO_CONFIG.engineSound === 'muted'
            ? 0
            : Math.tanh(pulse * 0.35 + subRumble * 0.45);

        // Apply linear fade-in at start
        if (i < fadeSamples) {
            sample *= (0.5 * i / fadeSamples);
        } 
        // Apply linear fade-out at end
        else if (i > length - fadeSamples) {
            sample *= (0.5 * (length - i) / fadeSamples);
        }

        engineFilterState += filterAmount * (sample - engineFilterState);
        samples[i] = engineFilterState;
        enginePhase = (enginePhase + (baseFreq / sampleRate)) % 10 ;
    }

    return buffer;
}
function playProcGenSound(scene, audioBuffer) {
    const ctx = scene.sound.context;
    if (!scene.engineLowPassFilter) {
        scene.engineLowPassFilter = ctx.createBiquadFilter();
        scene.engineLowPassFilter.type = 'lowpass';
        scene.engineLowPassFilter.frequency.setValueAtTime(
            AUDIO_CONFIG.lowPassFrequency,
            ctx.currentTime
        );
        scene.engineLowPassFilter.connect(scene.sound.masterVolumeNode || ctx.destination);
    }

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(scene.engineLowPassFilter);
    source.onended = () => playProcGenSound(scene, makeEngineBuffer(ctx, engineRev));
    source.start(0);
}

function applyLateralGrip(scene, body, maxImpulse) {
    const rightX = Math.cos(body.angle);
    const rightY = Math.sin(body.angle);
    const lateralSpeed = body.velocity.x * rightX + body.velocity.y * rightY;
    const impulse = Phaser.Math.Clamp(-lateralSpeed * body.mass, -maxImpulse, maxImpulse);
    const velocityChange = impulse / body.mass;

    scene.matter.body.setVelocity(body, {
        x: body.velocity.x + rightX * velocityChange,
        y: body.velocity.y + rightY * velocityChange
    });
}

function applyForwardDrag(scene, body, forwardX, forwardY, forwardSpeed) {
    const drag = -forwardSpeed * CAR_CONFIG.forwardDrag;
    scene.matter.body.applyForce(body, body.position, {
        x: forwardX * drag,
        y: forwardY * drag
    });
}

function updateRearTuning(scene, amount, output) {
    rearTuningAmount = Phaser.Math.Clamp(amount, 0, 1);
    const interpolate = ({ atZero, atOne }) => atZero + (atOne - atZero) * amount;
    const density = interpolate(REAR_TUNING.density);
    const friction = interpolate(REAR_TUNING.friction);
    const frictionAir = interpolate(REAR_TUNING.frictionAir);
    const turnForceBoost = CAR_CONFIG.maxRearTurnForceBoost * (1 - rearTuningAmount);

    scene.matter.body.setDensity(carRear, density);
    carRear.friction = friction;
    carRear.frictionAir = frictionAir;
    output.textContent = `Density ${density.toFixed(3)} | Friction ${friction.toFixed(3)} | Air ${frictionAir.toFixed(3)} | Turn boost ${turnForceBoost.toFixed(2)}`;
}

function drawGauge(
    graphics,
    centerX,
    centerY,
    value,
    maxValue,
    label,
    valueText,
    radius = GAUGE_CONFIG.radius,
    textX = centerX,
    labelY = centerY + 8,
    valueY = centerY + 30
) {
    const startAngle = Phaser.Math.DegToRad(120);
    const endAngle = startAngle + Phaser.Math.DegToRad(GAUGE_CONFIG.arcDegrees);
    const amount = Phaser.Math.Clamp(value / maxValue, 0, 1);
    const color = Phaser.Display.Color.Interpolate.ColorWithColor(
        new Phaser.Display.Color(40, 230, 125),
        new Phaser.Display.Color(255, 55, 55),
        100,
        Math.round(amount * 100)
    );
    const colorValue = Phaser.Display.Color.GetColor(color.r, color.g, color.b);

    graphics.clear();
    graphics.lineStyle(2, 0x52615c, 0.7);
    graphics.beginPath();
    graphics.arc(centerX, centerY, radius, startAngle, endAngle, false);
    graphics.strokePath();

    if (amount > 0) {
        graphics.lineStyle(3 + amount * 11, colorValue, 1);
        graphics.beginPath();
        graphics.arc(centerX, centerY, radius, startAngle,
            startAngle + (endAngle - startAngle) * amount, false);
        graphics.strokePath();
    }

    label.setPosition(textX, labelY).setOrigin(0.5);
    valueText.setPosition(textX, valueY).setOrigin(0.5).setText(value.toFixed(0));
}

function create() {
    playProcGenSound(this, makeEngineBuffer(this.sound.context, engineRev));

    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    socket.onmessage = ({ data }) => JSON.parse(data).forEach(p => {
        const ghost = ghosts[p.id] ||= {
            body: this.add.rectangle(0, 0, 40, 55, 0xff0000, 0).setDepth(4),
            car: this.add.image(0, 0, 'car').setDisplaySize(46, 97).setAlpha(0.7).setDepth(6)
        };
        ghost.body.setPosition(p.x, p.y).setRotation(p.rot);
        const forwardX = Math.sin(p.rot);
        const forwardY = -Math.cos(p.rot);
        ghost.car.setPosition(p.x - forwardX * 28, p.y - forwardY * 28).setRotation(p.rot);
    });

    // Big world
    this.matter.world.setBounds(0, 0, worldsize, worldsize);

    this.trackStripePositions = createTrack(this);
    this.nextPickupPositionIndex = 2;
    this.pickupRectangles = PICKUP_CONFIG.rectangles.map(({ width, height, color }) =>
        this.add.rectangle(0, 0, width, height, color, 0.12)
                .setStrokeStyle(6, color, 1)
            .setDepth(8)
    );
    spawnNextPickup(this);

    // === CAR ===
    const startX = TRACK_START.x;
    const startY = TRACK_START.y;

    // Front
    carFront = this.matter.add.rectangle(startX, startY - 28, 40, 55, {
        friction: 0.05,
        frictionAir: 0.02,
        restitution: 0.1,
        density: 0.004,
        chamfer: { radius: 6 }
    });

    // Rear
    carRear = this.matter.add.rectangle(startX, startY + 28, 46, 55, {
        friction: 0.008,
        frictionAir: 0.003,
        restitution: 0.1,
        density: 0.015,
        chamfer: { radius: 6 },
    });

    const rearTuningSlider = document.getElementById('rear-tuning-slider');
    const rearTuningOutput = document.getElementById('rear-tuning-output');
    const applyRearTuning = () => updateRearTuning(
        this,
        Number(rearTuningSlider.value),
        rearTuningOutput
    );
    rearTuningSlider.addEventListener('input', applyRearTuning);
    applyRearTuning();

    // Two soft springs, side by side, to keep the body from acting like one rigid link
    this.matter.add.spring(carFront, carRear, 56, 1, {
        damping: 0.15,
        pointA: { x: -12, y: 0 },
        pointB: { x: -12, y: 0 }
    });

    this.matter.add.spring(carFront, carRear, 56, 1, {
        damping: 0.15,
        pointA: { x: 12, y: 0 },
        pointB: { x: 12, y: 0 }
    });

    this.matter.add.spring(carFront, carRear, 56, 1, {
        damping: 0.15,
        pointA: { x: 0, y: 0 },
        pointB: { x: 0, y: 0 }
    });

    // Colored visual bodies (on top of debug wireframes)
    this.frontGfx = this.add.rectangle(0, 0, 40, 55, 0x00ff88, 0).setDepth(5);
    this.rearGfx  = this.add.rectangle(0, 0, 46, 55, 0x00cc66, 0).setDepth(5);
    this.carGfx = this.add.image(0, 0, 'car')
        .setDisplaySize(46, 97)
        .setAlpha(1)
        .setDepth(6);

    this.skidGfx = this.add.graphics().setDepth(6);
    this.accelerationGauge = this.add.graphics().setScrollFactor(0).setDepth(20);
    this.speedGauge = this.add.graphics().setScrollFactor(0).setDepth(20);
    this.accelerationGaugeLabel = this.add.text(0, 0, 'REV / ACCEL', {
        fontSize: '11px',
        color: '#dce6df',
        fontStyle: 'bold'
    }).setScrollFactor(0).setDepth(21);
    this.accelerationGaugeValue = this.add.text(0, 0, '0', {
        fontSize: '18px',
        color: '#ffffff'
    }).setScrollFactor(0).setDepth(21);
    this.speedGaugeLabel = this.add.text(0, 0, 'SPEED', {
        fontSize: '11px',
        color: '#dce6df',
        fontStyle: 'bold'
    }).setScrollFactor(0).setDepth(21);
    this.speedGaugeValue = this.add.text(0, 0, '0', {
        fontSize: '22px',
        color: '#ffffff'
    }).setScrollFactor(0).setDepth(21);
    const gaugeModeButton = document.getElementById('gauge-mode-button');
    gaugeModeButton.addEventListener('click', () => {
        gaugeMode = gaugeMode === 'split' ? 'combined' : 'split';
        gaugeModeButton.textContent = `Gauges: ${gaugeMode}`;
        gaugeModeButton.setAttribute('aria-pressed', String(gaugeMode === 'combined'));
    });
    document.getElementById('engine-sound-mode').addEventListener('change', (event) => {
        AUDIO_CONFIG.engineSound = event.target.value;
    });
    skidMarks = [];
    lastRearLeft = null;
    lastRearRight = null;

    // Controls
    cursors = this.input.keyboard.createCursorKeys();
    wasd = this.input.keyboard.addKeys({
        up: Phaser.Input.Keyboard.KeyCodes.W,
        left: Phaser.Input.Keyboard.KeyCodes.A,
        right: Phaser.Input.Keyboard.KeyCodes.D,
        boost: Phaser.Input.Keyboard.KeyCodes.SPACE
    });

    // Camera
    this.cameras.main.setBounds(0, 0, worldsize, worldsize);
    this.cameras.main.startFollow(this.frontGfx);
    this.cameras.main.setZoom(zoom);

    // Zoom
    this.input.on('wheel', (pointer, gameObjects, deltaX, deltaY) => {
        zoom = Phaser.Math.Clamp(zoom - deltaY * 0.0005, 0.035, 2.5);
        this.cameras.main.setZoom(zoom);
    });

    // UI
    this.add.text(16, 16, 'W / ↑  Accelerate\n↓ / Space  Boost\nA D or ← →  Steer\nMouse wheel  Zoom', {
        fontSize: '18px',
        fill: '#ffffff',
        backgroundColor: '#000000aa',
        padding: { x: 12, y: 10 }
    }).setScrollFactor(0).setDepth(20);
}

function update(time, delta) {
    if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ x: carFront.position.x, y: carFront.position.y, rot: carFront.angle }));
    }

    // Sync visuals to physics bodies
    this.frontGfx.setPosition(carFront.position.x, carFront.position.y);
    this.frontGfx.setRotation(carFront.angle);

    this.rearGfx.setPosition(carRear.position.x, carRear.position.y);
    this.rearGfx.setRotation(carRear.angle);
    this.carGfx.setPosition(
        (carFront.position.x + carRear.position.x) / 2,
        (carFront.position.y + carRear.position.y) / 2
    );
    this.carGfx.setRotation(carFront.angle);

    const pickupX = this.pickupRectangles[0].x;
    const pickupY = this.pickupRectangles[0].y;
    if (Math.hypot(carFront.position.x - pickupX, carFront.position.y - pickupY)
        <= TRACK_ROAD_WIDTH / 2 * 1.2) { // 20% margin of error
        PICKUP_AUDIO_KEYS.forEach(key => this.sound.play(key));
        spawnNextPickup(this);
    }
    PICKUP_CONFIG.rectangles.forEach((rectangle, index) => {
        this.pickupRectangles[index].rotation += rectangle.rotationSpeed * delta / 1000;
    });

    // === CONTROLS ===
    const accelerating = cursors.up.isDown || wasd.up.isDown;
    const boosting = wasd.boost.isDown || cursors.down.isDown;
    const angle = carFront.angle;
    const forwardX = Math.sin(angle);
    const forwardY = -Math.cos(angle);
    const forwardSpeed = carFront.velocity.x * forwardX + carFront.velocity.y * forwardY;
    const maxSpeed = boosting ? CAR_CONFIG.boostMaxSpeed : CAR_CONFIG.maxSpeed;
    const response = 1 - Math.exp(-delta / (CAR_CONFIG.accelerationResponseSeconds * 1000));
    accelerationAmount += ((accelerating ? 1 : 0) - accelerationAmount) * response;
    boostAmount += ((boosting ? 1 : 0) - boostAmount) * response;
    const force = accelerationAmount * CAR_CONFIG.driveForce
        + boostAmount * CAR_CONFIG.boostForce;

    // Drive force stops at the speed cap; it never assigns the car's speed directly.
    if (force > 0 && forwardSpeed < maxSpeed) {
        this.matter.body.applyForce(carFront, carFront.position, {
            x: forwardX * force,
            y: forwardY * force
        });
    }

    applyForwardDrag(this, carFront, forwardX, forwardY, forwardSpeed);
    applyLateralGrip(this, carFront, CAR_CONFIG.maxLateralImpulse);
    applyLateralGrip(this, carRear, CAR_CONFIG.maxLateralImpulse);

    const steeringInput = (cursors.left.isDown || wasd.left.isDown ? -1 : 0)
        + (cursors.right.isDown || wasd.right.isDown ? 1 : 0);
    const moving = Math.hypot(carFront.velocity.x, carFront.velocity.y)
        > CAR_CONFIG.minimumSteeringSpeed;
    const targetTurnRate = moving ? steeringInput * CAR_CONFIG.maxTurnRate : 0;
    const frameScale = delta / (1000 / 60);
    const turnRateStep = CAR_CONFIG.maxTurnRate * 2
        * delta / (CAR_CONFIG.steeringLockToLockSeconds * 1000);
    const dampedTurnRate = carFront.angularVelocity
        * Math.pow(CAR_CONFIG.angularDampingPerFrame, frameScale);

    const turnForceBoost = CAR_CONFIG.maxRearTurnForceBoost * (1 - rearTuningAmount);
    if (moving && steeringInput !== 0 && turnForceBoost > 0) {
        const rightX = Math.cos(angle);
        const rightY = Math.sin(angle);
        this.matter.body.applyForce(carFront, {
            x: carFront.position.x + forwardX * 27,
            y: carFront.position.y + forwardY * 27
        }, {
            x: rightX * steeringInput * turnForceBoost,
            y: rightY * steeringInput * turnForceBoost
        });
    }

    this.matter.body.setAngularVelocity(carFront, Phaser.Math.Clamp(
        targetTurnRate,
        dampedTurnRate - turnRateStep,
        dampedTurnRate + turnRateStep
    ));
    this.matter.body.setAngularVelocity(carRear, carRear.angularVelocity
        * Math.pow(CAR_CONFIG.angularDampingPerFrame, frameScale));

    // Simple skid marks: draw behind the rear wheels when the car is moving and turning/accelerating
    const speed = Math.hypot(carRear.velocity.x, carRear.velocity.y);
    const steering = cursors.left.isDown || wasd.left.isDown || cursors.right.isDown || wasd.right.isDown;
    const revTarget = accelerationAmount * 0.65 + boostAmount * 0.35;
    engineRev += (revTarget - engineRev) * .04;

    const speedValue = Math.hypot(carFront.velocity.x, carFront.velocity.y);
    if (gaugeMode === 'combined') {
        drawGauge(
            this.accelerationGauge,
            400,
            660,
            revTarget,
            GAUGE_CONFIG.accelerationMax,
            this.accelerationGaugeLabel,
            this.accelerationGaugeValue,
            GAUGE_CONFIG.combinedInnerRadius,
            350,
            665,
            690
        );
        drawGauge(
            this.speedGauge,
            400,
            660,
            speedValue,
            GAUGE_CONFIG.speedMax,
            this.speedGaugeLabel,
            this.speedGaugeValue,
            GAUGE_CONFIG.combinedRadius,
            450,
            665,
            690
        );
    } else {
        drawGauge(
            this.accelerationGauge,
            260,
            680,
            revTarget,
            GAUGE_CONFIG.accelerationMax,
            this.accelerationGaugeLabel,
            this.accelerationGaugeValue
        );
        drawGauge(
            this.speedGauge,
            540,
            680,
            speedValue,
            GAUGE_CONFIG.speedMax,
            this.speedGaugeLabel,
            this.speedGaugeValue
        );
    }

    if (speed > 0.8 && (steering || accelerating)) {
        const forwardX = Math.sin(carRear.angle);
        const forwardY = -Math.cos(carRear.angle);
        const sideX = Math.cos(carRear.angle);
        const sideY = Math.sin(carRear.angle);

        const rearLeft = {
            x: carRear.position.x + sideX * 18 - forwardX * 20,
            y: carRear.position.y + sideY * 18 - forwardY * 20
        };
        const rearRight = {
            x: carRear.position.x - sideX * 18 - forwardX * 20,
            y: carRear.position.y - sideY * 18 - forwardY * 20
        };

        if (lastRearLeft) {
            const dx = rearLeft.x - lastRearLeft.x;
            const dy = rearLeft.y - lastRearLeft.y;
            if (Math.hypot(dx, dy) > 3) {
                skidMarks.push({ x1: lastRearLeft.x, y1: lastRearLeft.y, x2: rearLeft.x, y2: rearLeft.y, life: 450 });
            }
        }
        if (lastRearRight) {
            const dx = rearRight.x - lastRearRight.x;
            const dy = rearRight.y - lastRearRight.y;
            if (Math.hypot(dx, dy) > 3) {
                skidMarks.push({ x1: lastRearRight.x, y1: lastRearRight.y, x2: rearRight.x, y2: rearRight.y, life: 450 });
            }
        }

        lastRearLeft = rearLeft;
        lastRearRight = rearRight;
    } else {
        lastRearLeft = null;
        lastRearRight = null;
    }

    this.skidGfx.clear();
    for (let i = skidMarks.length - 1; i >= 0; i--) {
        const mark = skidMarks[i];
        mark.life -= 1;
        if (mark.life <= 0) {
            skidMarks.splice(i, 1);
            continue;
        }

        const alpha = mark.life / 450;
        this.skidGfx.lineStyle(6, 0x101010, alpha);
        this.skidGfx.lineBetween(mark.x1, mark.y1, mark.x2, mark.y2);
    }
}