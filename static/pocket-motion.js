(function () {
    "use strict";

    const library = window.anime;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const compactLayout = window.matchMedia("(max-width: 720px)");
    const active = new Map();
    const toggleStates = new WeakMap();
    const optionStates = new WeakMap();
    const spinners = new Map();
    let ambientAnimations = [];
    const styleLayoutState = { key: null, pending: null, phase: null };

    function enabled() {
        return Boolean(library) && !reducedMotion.matches;
    }

    function clear(element, properties) {
        for (const property of properties) element.style.removeProperty(property);
    }

    function cancel(element) {
        active.get(element)?.cancel();
        active.delete(element);
    }

    function finish(element) {
        active.get(element)?.complete();
    }

    function play(element, parameters, complete = () => {}) {
        cancel(element);
        if (!enabled()) {
            complete();
            return;
        }
        const animation = library.animate(element, {
            duration: 260,
            ease: "outCubic",
            ...parameters,
            onComplete() {
                active.delete(element);
                complete();
            }
        });
        active.set(element, animation);
    }

    function showModal(modal) {
        modal.style.display = "flex";
        play(modal, { opacity: [0, 1], duration: 220 }, () => clear(modal, ["opacity"]));
        const content = modal.querySelector(".preview-content, .style-content");
        const entrance = modal.id === "styleModal"
            ? { opacity: [0, 1], duration: 220 }
            : { opacity: [0, 1], y: [24, 0], scale: [0.97, 1], duration: 360 };
        play(content, entrance, () => {
            clear(content, ["opacity", "transform"]);
        });
    }

    function revealCamera(container) {
        play(container, { opacity: [0, 1], duration: 280 }, () => clear(container, ["opacity"]));
    }

    function prepareNativeSelect() {
        finishStyleLayout();
        const modal = document.getElementById("styleModal");
        finish(modal);
        modal.querySelectorAll(".style-dialog-layout, .style-content, .frame-option, .frame-color-panel").forEach(finish);
        for (const animation of modal.getAnimations({ subtree: true })) {
            if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) animation.finish();
        }
    }

    function hideModal(modal, complete = () => {}) {
        play(modal, { opacity: 0, duration: 160 }, () => {
            modal.style.display = "none";
            clear(modal, ["opacity"]);
            complete();
        });
    }

    function toggle(input, animate = true) {
        if (toggleStates.get(input) === input.checked) return;
        toggleStates.set(input, input.checked);
        const track = input.nextElementSibling;
        const thumb = track.querySelector(".frame-toggle-thumb");
        const colors = getComputedStyle(document.documentElement);
        const backgroundColor = input.checked ? colors.getPropertyValue("--primary").trim() : "#dcd4ca";
        const borderColor = input.checked ? backgroundColor : colors.getPropertyValue("--border").trim();
        const x = input.checked ? 22 : 0;
        if (!animate || !enabled()) {
            cancel(track);
            cancel(thumb);
            track.style.backgroundColor = backgroundColor;
            track.style.borderColor = borderColor;
            thumb.style.transform = `translateX(${x}px)`;
            return;
        }
        play(track, { backgroundColor, borderColor, duration: 220 });
        play(thumb, { x, duration: 240 });
    }

    function syncToggles(animate = true) {
        document.querySelectorAll(".frame-toggle input").forEach(input => toggle(input, animate));
    }

    function option(element, visible, animate = true) {
        if ((optionStates.get(element) ?? !element.hidden) === visible) return;
        optionStates.set(element, visible);
        const wasHidden = element.hidden;
        cancel(element);
        const properties = ["height", "margin-bottom", "padding-top", "padding-bottom", "opacity", "overflow", "transform"];
        const finish = () => {
            element.hidden = !visible;
            element.inert = !visible;
            clear(element, properties);
        };
        if (!animate || !enabled() || getComputedStyle(document.getElementById("styleModal")).display === "none") {
            finish();
            return;
        }
        const current = getComputedStyle(element);
        const from = {
            height: wasHidden ? 0 : element.getBoundingClientRect().height,
            margin: wasHidden ? 0 : parseFloat(current.marginBottom),
            paddingTop: wasHidden ? 0 : parseFloat(current.paddingTop),
            paddingBottom: wasHidden ? 0 : parseFloat(current.paddingBottom),
            opacity: wasHidden ? 0 : parseFloat(current.opacity)
        };
        element.hidden = false;
        element.inert = !visible;
        clear(element, properties);
        const natural = getComputedStyle(element);
        const height = element.getBoundingClientRect().height;
        const margin = parseFloat(natural.marginBottom);
        const paddingTop = parseFloat(natural.paddingTop);
        const paddingBottom = parseFloat(natural.paddingBottom);
        element.style.overflow = "hidden";
        play(element, {
            height: [from.height, visible ? height : 0],
            marginBottom: [from.margin, visible ? margin : 0],
            paddingTop: [from.paddingTop, visible ? paddingTop : 0],
            paddingBottom: [from.paddingBottom, visible ? paddingBottom : 0],
            opacity: [from.opacity, visible ? 1 : 0],
            duration: visible ? 280 : 200
        }, finish);
    }

    function denoising(element, index, animate = true) {
        const position = `${index / 3 * 100}%`;
        const finishSelection = () => element.style.setProperty("--denoising-position", position);
        if (!animate) {
            cancel(element);
            finishSelection();
            return;
        }
        play(element, { "--denoising-position": position, duration: 180 }, finishSelection);
    }

    function framePanel(visible, animate = true) {
        const panel = document.getElementById("frameColorPanel");
        panel.classList.toggle("is-visible", visible);
        panel.setAttribute("aria-hidden", String(!visible));
        option(panel, visible, animate);
    }

    function styleLayout(key, apply, animate = true) {
        const modal = document.getElementById("styleModal");
        const body = modal.querySelector(".style-options-body");
        const state = styleLayoutState;
        state.pending = { key, apply };
        const immediate = !animate || !enabled() || getComputedStyle(modal).display === "none" || state.key === null;
        if (immediate) {
            cancel(body);
            state.phase = null;
            state.pending = null;
            body.style.opacity = "0";
            apply();
            state.key = key;
            clear(body, ["opacity"]);
            body.removeAttribute("aria-busy");
            return;
        }
        if (state.phase === "out") return;
        if (key === state.key) {
            state.pending = null;
            apply();
            return;
        }
        state.phase = "out";
        body.setAttribute("aria-busy", "true");
        play(body, { opacity: 0, duration: 160 }, () => {
            body.style.opacity = "0";
            const pending = state.pending;
            state.pending = null;
            pending.apply();
            state.key = pending.key;
            state.phase = "in";
            play(body, { opacity: [0, 1], duration: 180 }, () => {
                state.phase = null;
                clear(body, ["opacity"]);
                body.removeAttribute("aria-busy");
            });
        });
    }

    function finishStyleLayout() {
        const body = document.querySelector("#styleModal .style-options-body");
        if (!body || !styleLayoutState.phase) return;
        finish(body);
        if (styleLayoutState.phase === "in") finish(body);
    }

    function openConfirmation(dialog) {
        dialog.showModal();
        dialog.style.setProperty("--backdrop-opacity", "0");
        play(dialog, { opacity: [0, 1], "--backdrop-opacity": [0, 1], y: [8, 0], duration: 220 }, () => {
            clear(dialog, ["opacity", "transform", "--backdrop-opacity"]);
        });
    }

    function closeConfirmation(dialog, value) {
        if (!dialog.open || dialog.dataset.closing === "true") return;
        dialog.dataset.closing = "true";
        dialog.querySelectorAll("button").forEach(button => { button.disabled = true; });
        play(dialog, { opacity: 0, "--backdrop-opacity": 0, y: -6, duration: 160 }, () => {
            dialog.close(value);
            clear(dialog, ["opacity", "transform", "--backdrop-opacity"]);
            delete dialog.dataset.closing;
            dialog.querySelectorAll("button").forEach(button => { button.disabled = false; });
        });
    }

    function notice(toast, visible) {
        const wasVisible = toast.classList.contains("is-visible");
        toast.classList.toggle("is-visible", visible);
        toast.style.visibility = "visible";
        play(toast, {
            opacity: visible && !wasVisible ? [0, 1] : visible ? 1 : 0,
            y: visible && !wasVisible ? [toast.offsetHeight + 32, 0] : visible ? 0 : toast.offsetHeight + 32,
            duration: visible ? 320 : 200
        }, () => clear(toast, ["opacity", "transform", "visibility"]));
    }

    function countdown(overlay, visible) {
        overlay.classList.toggle("active", visible);
        overlay.style.visibility = "visible";
        play(overlay, { opacity: visible ? [0, 1] : 0, duration: 160 }, () => clear(overlay, ["opacity", "visibility"]));
    }

    function pulse(number) {
        if (!enabled()) {
            number.style.opacity = "1";
            number.style.transform = "none";
            return;
        }
        play(number, {
            keyframes: [
                { opacity: 0, scale: 2, duration: 0 },
                { opacity: 1, scale: 1, duration: 240 },
                { opacity: 1, scale: 1, duration: 400 },
                { opacity: 0, scale: 0.8, duration: 160 }
            ]
        });
    }

    function startSpinner(element) {
        if (!enabled() || spinners.has(element)) return;
        spinners.set(element, library.animate(element, { rotate: [0, 360], duration: 900, loop: true, ease: "linear" }));
    }

    function stopSpinner(element) {
        spinners.get(element)?.cancel();
        spinners.delete(element);
    }

    function startAmbient() {
        if (!enabled()) return;
        document.querySelectorAll(".ambient").forEach((element, index) => {
            ambientAnimations.push(library.animate(element, {
                x: [0, 40], y: [0, -40], duration: 7500, alternate: true, loop: true,
                delay: index * 700, ease: "inOutSine"
            }));
        });
    }

    function init() {
        syncToggles(false);
        document.querySelectorAll(".frame-toggle input").forEach(input => {
            input.addEventListener("change", () => toggle(input));
        });
        document.querySelectorAll("#styleModal select").forEach(select => {
            select.addEventListener("pointerdown", prepareNativeSelect);
            select.addEventListener("focus", prepareNativeSelect);
            select.addEventListener("keydown", event => {
                if (["ArrowDown", "ArrowUp", "Enter", " ", "F4"].includes(event.key)) prepareNativeSelect();
            });
        });
        if (!library) return;
        document.documentElement.classList.add("motion-ready");
        startAmbient();
        document.querySelectorAll(".btn, .coin-quick-add-button").forEach(element => {
            const hover = () => {
                if (element.matches(":disabled") || element.closest("label")?.querySelector("input:disabled")) return;
                play(element, { y: -2, scale: 1, duration: 180 });
            };
            element.addEventListener("pointerenter", event => { if (event.pointerType !== "touch") hover(); });
            element.addEventListener("pointerleave", () => play(element, { y: 0, scale: 1, duration: 180 }, () => clear(element, ["transform"])));
            element.addEventListener("pointerdown", () => {
                if (!element.matches(":disabled")) play(element, { y: 1, scale: 0.98, duration: 100 });
            });
            element.addEventListener("pointerup", () => play(element, { y: 0, scale: 1, duration: 180 }, () => clear(element, ["transform"])));
            element.addEventListener("pointercancel", () => play(element, { y: 0, scale: 1, duration: 100 }, () => clear(element, ["transform"])));
        });
        compactLayout.addEventListener("change", () => {
            finishStyleLayout();
            document.querySelectorAll("#styleModal .frame-option, #frameColorPanel").forEach(finish);
        });
        reducedMotion.addEventListener("change", () => {
            if (reducedMotion.matches) {
                for (const animation of Array.from(active.values())) animation.complete();
                ambientAnimations.forEach(animation => animation.cancel());
                ambientAnimations = [];
                document.querySelectorAll(".ambient").forEach(element => clear(element, ["transform"]));
                for (const element of spinners.keys()) stopSpinner(element);
            } else {
                startAmbient();
                document.querySelectorAll(".spinner").forEach(startSpinner);
            }
        });
    }

    window.pocketMotion = { init, revealCamera, showModal, hideModal, toggle, syncToggles, option, denoising, framePanel, styleLayout,
        openConfirmation, closeConfirmation, notice, countdown, pulse, startSpinner, stopSpinner };
})();
