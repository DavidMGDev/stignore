<script lang="ts">
    import { onMount } from "svelte";

    let { onclick, disabled, variant = "default" } = $props<{ 
        onclick: () => void; 
        disabled: boolean;
        variant?: "default" | "rotated" | "padded" | "wacky"
    }>();

    let canvasRef: HTMLCanvasElement;
    let rafRef: number;

    const TEXT = "COPY TO CLIPBOARD ";
    let DIAGONAL_OFFSET = -3;
    const SPEED = 0.5; 
    const CIRCLE_R = 40;
    const SPRING = 0.08;
    const FRICTION = 0.8;

    let W = 0;
    let H = 0;
    let particles: any[] = [];
    let charW = 8.5;
    let charH = 18;
    let cols = 0;
    let TOTAL_WIDTH = 0;

    let mouseX = -1000;
    let mouseY = -1000;
    let isHovering = false;

    if (variant === "wacky") {
        DIAGONAL_OFFSET = 1;
    }

    function handleMouseMove(e: MouseEvent) {
        if (!canvasRef) return;
        isHovering = true;
        const rect = canvasRef.getBoundingClientRect();
        mouseX = e.clientX - rect.left;
        mouseY = e.clientY - rect.top;
    }

    function handleMouseLeave() {
        isHovering = false;
        mouseX = -1000;
        mouseY = -1000;
    }

    function initParticles() {
        if (!canvasRef || W === 0 || H === 0) return;
        const ctx = canvasRef.getContext('2d');
        if (!ctx) return;
        
        ctx.font = 'bold 12px monospace';
        charW = ctx.measureText('M').width || 7.2;
        
        particles = [];
        // Overscan widely to cover rotated empty spots
        let overscan = variant === "rotated" ? 20 : 6;
        cols = Math.ceil(W / charW) + overscan; 
        const rows = Math.ceil(H / charH) + overscan;
        TOTAL_WIDTH = cols * charW;

        for (let r = -overscan/2; r < rows; r++) {   
            for (let c = -overscan/2; c < cols; c++) {
                particles.push({
                    baseX: c * charW,
                    baseY: r * charH + charH/2, 
                    row: r,
                    col: c,
                    dx: 0, dy: 0, vx: 0, vy: 0
                });
            }
        }
    }

    onMount(() => {
        const resizeObserver = new ResizeObserver((entries) => {
            const entry = entries[0];
            if (canvasRef) {
                W = entry.contentRect.width;
                H = entry.contentRect.height;
                canvasRef.width = W;
                canvasRef.height = H;
                initParticles();
            }
        });
        
        if (canvasRef.parentElement) {
            resizeObserver.observe(canvasRef.parentElement);
        }

        function draw() {
            if (!canvasRef || W === 0 || H === 0 || particles.length === 0) {
                rafRef = requestAnimationFrame(draw);
                return;
            }
            const ctx = canvasRef.getContext('2d');
            if (!ctx) return;

            ctx.clearRect(0, 0, W, H);

            // Handle rotation context
            if (variant === "rotated") {
                ctx.save();
                ctx.translate(W / 2, H / 2);
                ctx.rotate(-0.15); // ~8.5 degrees
                ctx.translate(-W / 2, -H / 2);
            }

            // Calculate inverse mouse coords for physics if rotated
            let effMouseX = mouseX;
            let effMouseY = mouseY;
            if (variant === "rotated" && isHovering) {
                let dx = mouseX - W/2;
                let dy = mouseY - H/2;
                let cosTh = Math.cos(0.15);
                let sinTh = Math.sin(0.15);
                effMouseX = W/2 + dx * cosTh - dy * sinTh;
                effMouseY = H/2 + dx * sinTh + dy * cosTh;
            }

            // Draw dotted circle based on effective coords, so it appears at true mouse
            if (isHovering && mouseX > -1000) {
                ctx.beginPath();
                ctx.strokeStyle = variant === "wacky" ? 'rgba(236, 72, 153, 0.6)' : 'rgba(52, 211, 153, 0.4)';
                ctx.lineWidth = variant === "wacky" ? 2 : 1;
                ctx.setLineDash(variant === "wacky" ? [2, 6] : [4, 4]);
                ctx.arc(effMouseX, effMouseY, variant === "wacky" ? CIRCLE_R * 1.5 : CIRCLE_R, 0, Math.PI * 2);
                ctx.stroke();
                ctx.setLineDash([]);
            }

            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.font = 'bold 12px monospace';

            for (let i = 0; i < particles.length; i++) {
                let p = particles[i];

                p.baseX -= SPEED;
                if (p.baseX < -charW * 4) {
                    p.baseX += TOTAL_WIDTH;
                    p.col += cols; 
                }

                let logicId = p.col + p.row * DIAGONAL_OFFSET;
                let charIndex = ((logicId % TEXT.length) + TEXT.length) % TEXT.length;

                let effectX = 0;
                let effectY = 0;

                if (isHovering) {
                    let dist = Math.hypot(p.baseX - effMouseX, p.baseY - effMouseY);
                    
                    if (variant === "wacky") {
                        if (dist < CIRCLE_R * 2.0) {
                            let angle = Math.atan2(p.baseY - effMouseY, p.baseX - effMouseX);
                            // Vortex orbital mechanics
                            effectX = Math.cos(angle - Math.PI*0.4) * 20 - Math.cos(angle) * 10;
                            effectY = Math.sin(angle - Math.PI*0.4) * 20 - Math.sin(angle) * 10;
                        }
                    } else {
                        if (dist < CIRCLE_R) {
                            let pushDist = CIRCLE_R - dist;
                            let angle = Math.atan2(p.baseY - effMouseY, p.baseX - effMouseX);
                            effectX = Math.cos(angle) * pushDist * 1.5;
                            effectY = Math.sin(angle) * pushDist * 1.5;
                        }
                    }
                }

                let accelX = (effectX - p.dx) * SPRING;
                let accelY = (effectY - p.dy) * SPRING;

                p.vx += accelX;
                p.vy += accelY;
                p.vx *= FRICTION;
                p.vy *= FRICTION;

                p.dx += p.vx;
                p.dy += p.vy;

                let drawX = p.baseX + p.dx;
                let drawY = p.baseY + p.dy;

                let disp = Math.hypot(p.dx, p.dy);
                let displayChar = TEXT[charIndex];
                
                if (variant === "wacky") {
                    let vel = Math.hypot(p.vx, p.vy);
                    if (vel > 2 && Math.random() > 0.8) {
                        const charset = "@#$%&*<>?!/\\";
                        displayChar = charset[Math.floor(Math.random() * charset.length)];
                        drawX += (Math.random() - 0.5) * 4;
                        drawY += (Math.random() - 0.5) * 4;
                    }
                    let intensity = Math.min(1, vel / 8);
                    let cr = Math.round(90 + (236 - 90) * intensity); // Pink 500
                    let cg = Math.round(100 + (72 - 100) * intensity);
                    let cb = Math.round(150 + (153 - 150) * intensity);
                    ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
                } else {
                    let intensity = Math.min(1, disp / 12);
                    let cr = Math.round(71 + (52 - 71) * intensity);
                    let cg = Math.round(85 + (211 - 85) * intensity);
                    let cb = Math.round(105 + (153 - 105) * intensity);
                    ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
                }

                ctx.fillText(displayChar, drawX, drawY);
            }

            if (variant === "rotated") {
                ctx.restore();
            }

            rafRef = requestAnimationFrame(draw);
        }

        draw();

        return () => {
            cancelAnimationFrame(rafRef);
            resizeObserver.disconnect();
        };
    });
</script>

<button
    {onclick}
    {disabled}
    onmousemove={handleMouseMove}
    onmouseleave={handleMouseLeave}
    class="relative overflow-hidden min-h-[8rem] w-full bg-[#0f1115] transition-all text-left disabled:opacity-50 disabled:cursor-not-allowed block p-0 group
        {variant !== 'padded' ? 'rounded-3xl border border-emerald-500/10 hover:border-emerald-500/30 shadow-[0_0_15px_rgba(0,0,0,0.5)]' : 'bg-transparent'}"
>
    {#if variant !== 'padded'}
        <div class="absolute inset-0 bg-gradient-to-br from-emerald-900/10 to-teal-900/5 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none"></div>
    {/if}

    <div class="pointer-events-none
        {variant === 'padded' ? 'absolute inset-4 rounded-xl border border-emerald-500/30 shadow-[inset_0_0_20px_rgba(0,0,0,0.8)] shadow-[0_0_15px_rgba(0,0,0,0.5)] outline outline-1 outline-emerald-500/10 bg-[#0f1115]' : 'absolute inset-0'}
    ">
        <canvas bind:this={canvasRef} class="w-full h-full block touch-none {variant === 'padded' ? 'rounded-xl' : ''}"></canvas>
    </div>
</button>

<style>
    canvas {
        image-rendering: auto;
    }
</style>
