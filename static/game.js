const config = {
    type: Phaser.AUTO,
    width: 800,
    height: 600,
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
let zoom = 0.25;
let skidMarks = [];
let lastRearLeft = null;
let lastRearRight = null;
let socket;
const ghosts = {};
const playerId = Math.random().toString(36).slice(2);

function create() {
    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    socket.onmessage = ({ data }) => JSON.parse(data).forEach(p => {
        const ghost = ghosts[p.id] ||= this.add.rectangle(0, 0, 40, 55, 0xff0000, 0.35).setDepth(4);
        ghost.setPosition(p.x, p.y).setRotation(p.rot);
    });

    // Big world
    this.matter.world.setBounds(0, 0, 2000, 2000);

    // Simple grid so you can see movement
    const g = this.add.graphics().setDepth(-10);
    g.lineStyle(1, 0x333355, 0.6);
    for (let x = 0; x <= 2000; x += 100) {
        g.lineBetween(x, 0, x, 2000);
    }
    for (let y = 0; y <= 2000; y += 100) {
        g.lineBetween(0, y, 2000, y);
    }

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
    this.matter.add.spring(carFront, carRear, 56, 0.2, {
        damping: 0.15,
        pointA: { x: -12, y: 0 },
        pointB: { x: -12, y: 0 }
    });

    this.matter.add.spring(carFront, carRear, 56, 0.2, {
        damping: 0.15,
        pointA: { x: 12, y: 0 },
        pointB: { x: 12, y: 0 }
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
    this.cameras.main.setBounds(0, 0, 2000, 2000);
    //this.cameras.main.startFollow(carFront, true, 0.09, 0.09);
    this.cameras.main.setZoom(0.5);

    // Zoom
    this.input.on('wheel', (pointer, gameObjects, deltaX, deltaY) => {
        zoom = Phaser.Math.Clamp(zoom - deltaY * 0.001, 0.35, 2.5);
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

function update() {
    if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ x: carFront.position.x, y: carFront.position.y, rot: carFront.angle }));
    }

    // Sync visuals to physics bodies
    this.frontGfx.setPosition(carFront.position.x, carFront.position.y);
    this.frontGfx.setRotation(carFront.angle);

    this.rearGfx.setPosition(carRear.position.x, carRear.position.y);
    this.rearGfx.setRotation(carRear.angle);

    // === CONTROLS ===
    const force = 0.022;
    const turn = 0.04;

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