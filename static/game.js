const config = {
    type: Phaser.AUTO,
    width: 800,
    height: 800,
    backgroundColor: '#a5a5d3',
    physics: {
        default: 'matter',
        matter: {
            gravity: { y: 0 },
            debug: true,               // ← shows the physics bodies clearly
            debugBodyColor: 0x00ff88,
            debugWireframes: true
        }
    },
    scene: {
        create: create,
        update: update
    }
};

const game = new Phaser.Game(config);

let carFront, carRear;
let cursors, wasd;
let zoom = 1.0;
let skidMarks = [];
let lastRearLeft = null;
let lastRearRight = null;
let socket;
const ghosts = {};
const playerId = Math.random().toString(36).slice(2);
const worldsize = 20000;
let enginePhase = 0;
let engineRev = 0;
let engineFilterState = 0;

function perlin2D(x, y) {
    const fade = value => value * value * value * (value * (value * 6 - 15) + 10);
    const interpolate = (a, b, amount) => a + (b - a) * amount;
    const gradient = (gridX, gridY, offsetX, offsetY) => {
        const hash = Math.sin(gridX * 127.1 + gridY * 311.7) * 43758.5453;
        const angle = (hash - Math.floor(hash)) * Math.PI * 2;
        return Math.cos(angle) * offsetX + Math.sin(angle) * offsetY;
    };

    const gridX = Math.floor(x);
    const gridY = Math.floor(y);
    const offsetX = x - gridX;
    const offsetY = y - gridY;
    const blendX = fade(offsetX);
    const blendY = fade(offsetY);
    const top = interpolate(
        gradient(gridX, gridY, offsetX, offsetY),
        gradient(gridX + 1, gridY, offsetX - 1, offsetY),
        blendX
    );
    const bottom = interpolate(
        gradient(gridX, gridY + 1, offsetX, offsetY - 1),
        gradient(gridX + 1, gridY + 1, offsetX - 1, offsetY - 1),
        blendX
    );

    return interpolate(top, bottom, blendY);
}

function terrainNoise(x, y) {
    let total = 0;
    let amplitude = 1;
    let amplitudeSum = 0;

    for (let octave = 0; octave < 4; octave++) {
        const frequency = 2 ** octave / 1200;
        total += perlin2D(x * frequency, y * frequency) * amplitude;
        amplitudeSum += amplitude;
        amplitude *= 0.5;
    }

    return Phaser.Math.Clamp(0.5 + total / amplitudeSum * 1.5, 0, 1);
}

function createTerrain(scene) {
    const tileSize = 200;
    const threshold = 0.75;

    for (let x = 0; x < worldsize; x += tileSize) {
        for (let y = 0; y < worldsize; y += tileSize) {
            if (terrainNoise(x + tileSize / 2, y + tileSize / 2) > threshold) {
                scene.add.rectangle(
                    x + tileSize / 2,
                    y + tileSize / 2,
                    tileSize,
                    tileSize,
                    0x555577
                ).setDepth(-1);
                scene.matter.add.rectangle(
                    x + tileSize / 2,
                    y + tileSize / 2,
                    tileSize,
                    tileSize,
                    { isStatic: true }
                );
            }
        }
    }
}

function makeEngineBuffer(ctx, rev, duration = 0.02) {
    const sampleRate = ctx.sampleRate;
    const length = Math.floor(sampleRate * duration);
    const buffer = ctx.createBuffer(1, length, sampleRate);
    const samples = buffer.getChannelData(0);
    const baseFreq = 200 + rev * 700;
    const filterAmount = 1 - Math.exp(-2 * Math.PI * 1800 / sampleRate);

    // Fade in/out duration in samples (~2ms)
    const fadeSamples = Math.floor(sampleRate * 0.002);

    for (let i = 0; i < length; i++) {
        const noise = Math.random() * 2 - 1;
        const pulse = Math.sin(2 * Math.PI * enginePhase)
            + 0.35 * Math.sin(4 * Math.PI * enginePhase);
        const subRumble = Math.sin(Math.PI * enginePhase);
        
        let sample = Math.tanh(noise * 0.25 + pulse * 0.35 + subRumble * 0.15);

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
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(scene.sound.masterVolumeNode || ctx.destination);
    source.onended = () => playProcGenSound(scene, makeEngineBuffer(ctx, engineRev));
    source.start(0);
}

function create() {
    playProcGenSound(this, makeEngineBuffer(this.sound.context, engineRev));

    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    socket.onmessage = ({ data }) => JSON.parse(data).forEach(p => {
        const ghost = ghosts[p.id] ||= this.add.rectangle(0, 0, 40, 55, 0xff0000, 0.35).setDepth(4);
        ghost.setPosition(p.x, p.y).setRotation(p.rot);
    });

    // Big world
    this.matter.world.setBounds(0, 0, worldsize, worldsize);

    createTerrain(this);

    // === CAR ===
    const startX = 1000;
    const startY = 1000;

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
        friction: 0.08,
        frictionAir: 0.03,
        restitution: 0.1,
        density: 0.005,
        chamfer: { radius: 6 }
    });

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
    this.frontGfx = this.add.rectangle(0, 0, 40, 55, 0x00ff88, 0.85).setDepth(5);
    this.rearGfx  = this.add.rectangle(0, 0, 46, 55, 0x00cc66, 0.85).setDepth(5);

    this.skidGfx = this.add.graphics().setDepth(6);
    skidMarks = [];
    lastRearLeft = null;
    lastRearRight = null;

    // Controls
    cursors = this.input.keyboard.createCursorKeys();
    wasd = this.input.keyboard.addKeys({
        up: Phaser.Input.Keyboard.KeyCodes.W,
        left: Phaser.Input.Keyboard.KeyCodes.A,
        right: Phaser.Input.Keyboard.KeyCodes.D
    });

    // Camera
    this.cameras.main.setBounds(0, 0, worldsize, worldsize);
    this.cameras.main.startFollow(this.frontGfx);

    // Zoom
    this.input.on('wheel', (pointer, gameObjects, deltaX, deltaY) => {
        zoom = Phaser.Math.Clamp(zoom - deltaY * 0.001, 0.035, 2.5);
        this.cameras.main.setZoom(zoom);
    });

    // UI
    this.add.text(16, 16, 'W / ↑  Accelerate\nA D or ← →  Steer\nMouse wheel  Zoom', {
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

    // === CONTROLS ===
    const force = 0.09;
    const turn = 0.08;

    const angle = carFront.angle;

    // Accelerate in facing direction
    if (cursors.up.isDown || wasd.up.isDown) {
        this.matter.body.applyForce(carFront, carFront.position, {
            x: Math.sin(angle) * force,
            y: -Math.cos(angle) * force
        });
    }

    // Steering
    if (cursors.left.isDown || wasd.left.isDown) {
        this.matter.body.setAngularVelocity(carFront, -turn);
        //this.matter.body.setAngularVelocity(carRear, -turn * 0.75);
    } else if (cursors.right.isDown || wasd.right.isDown) {
        this.matter.body.setAngularVelocity(carFront, turn);
        //this.matter.body.setAngularVelocity(carRear, turn * 0.75);
    } else {
        // damp rotation when not steering
        this.matter.body.setAngularVelocity(carFront, carFront.angularVelocity * 0.99);
        this.matter.body.setAngularVelocity(carRear, carRear.angularVelocity * 0.99);
    }

    // Simple skid marks: draw behind the rear wheels when the car is moving and turning/accelerating
    const speed = Math.hypot(carRear.velocity.x, carRear.velocity.y);
    const steering = cursors.left.isDown || wasd.left.isDown || cursors.right.isDown || wasd.right.isDown;
    const accelerating = cursors.up.isDown || wasd.up.isDown;
    const revTarget = wasd.up.isDown ? 1 : 0;
    engineRev += (revTarget - engineRev) * .05;

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
                skidMarks.push({ x1: lastRearLeft.x, y1: lastRearLeft.y, x2: rearLeft.x, y2: rearLeft.y, life: 900 });
            }
        }
        if (lastRearRight) {
            const dx = rearRight.x - lastRearRight.x;
            const dy = rearRight.y - lastRearRight.y;
            if (Math.hypot(dx, dy) > 3) {
                skidMarks.push({ x1: lastRearRight.x, y1: lastRearRight.y, x2: rearRight.x, y2: rearRight.y, life: 900 });
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

        const alpha = mark.life / 900;
        this.skidGfx.lineStyle(6, 0x101010, alpha);
        this.skidGfx.lineBetween(mark.x1, mark.y1, mark.x2, mark.y2);
    }
}