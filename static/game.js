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

function createTrack(scene) {
    const centerX = worldsize / 2;
    const centerY = worldsize / 2;
    const startAngle = Math.atan2(1000 - centerY, 1000 - centerX);
    const startRadius = Math.hypot(1000 - centerX, 1000 - centerY);
    const margin = 600;
    const bends = [
        { frequency: 3, cosine: 650 + Math.random() * 250, sine: 500 + Math.random() * 300 },
        { frequency: 5, cosine: 450 + Math.random() * 250, sine: 350 + Math.random() * 250 },
        { frequency: 7, cosine: 300 + Math.random() * 200, sine: 250 + Math.random() * 200 },
        { frequency: 11, cosine: 180 + Math.random() * 160, sine: 150 + Math.random() * 150 }
    ];
    const points = [];
    const divisions = 720;

    for (let i = 0; i < divisions; i++) {
        const angle = i / divisions * Math.PI * 2;
        const offset = angle - startAngle;
        let radius = startRadius;
        for (const bend of bends) {
            radius += bend.cosine * (Math.cos(bend.frequency * offset) - 1)
                + bend.sine * Math.sin(bend.frequency * offset);
        }

        const dx = Math.cos(angle);
        const dy = Math.sin(angle);
        let maxRadius = Infinity;
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

    const track = scene.add.graphics().setDepth(-1);
    track.lineStyle(580, 0x252530, 1);
    track.beginPath();
    track.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
        track.lineTo(points[i].x, points[i].y);
    }
    track.closePath();
    track.strokePath();

    track.lineStyle(140, 0x555566, 1);
    track.strokePath();

    track.lineStyle(5, 0xd8d2a8, 0.8);
    for (let i = 0; i < points.length; i += 12) {
        const end = (i + 5) % points.length;
        track.lineBetween(points[i].x, points[i].y, points[end].x, points[end].y);
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

    createTrack(this);

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
        chamfer: { radius: 6 },
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
        right: Phaser.Input.Keyboard.KeyCodes.D,
        boost: Phaser.Input.Keyboard.KeyCodes.SPACE
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
    this.add.text(16, 16, 'W / ↑  Accelerate\nSpace  Boost\nA D or ← →  Steer\nMouse wheel  Zoom', {
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
    const accelerating = cursors.up.isDown || wasd.up.isDown;
    const boosting = wasd.boost.isDown;
    const force = (accelerating ? 0.04 : 0) + (boosting ? 0.03 : 0);
    const turn = 0.06;

    const angle = carFront.angle;

    // Accelerate in facing direction
    if (force > 0) {
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
    }
    this.matter.body.setAngularVelocity(carFront, carFront.angularVelocity * 0.90);
    this.matter.body.setAngularVelocity(carRear, carRear.angularVelocity * 0.90);

    // Simple skid marks: draw behind the rear wheels when the car is moving and turning/accelerating
    const speed = Math.hypot(carRear.velocity.x, carRear.velocity.y);
    const steering = cursors.left.isDown || wasd.left.isDown || cursors.right.isDown || wasd.right.isDown;
    const revTarget = (accelerating ? 0.65 : 0) + (boosting ? 0.35 : 0);
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