// ==UserScript==
// @name         UOOC_优课刷课_sztu软件工程
// @namespace    https://github.com/lzh19830513588-prog/uooc-video-autoplay
// @version      2.5.1
// @license      MPL-2.0
// @description  播放未完成视频、跳过章节测试、处理鼠标移出导致的自动暂停
// @author       somebody in SZTU
// @homepageURL  https://github.com/lzh19830513588-prog/uooc-video-autoplay
// @updateURL    https://raw.githubusercontent.com/lzh19830513588-prog/uooc-video-autoplay/main/uooc-video-autoplay.user.js
// @downloadURL  https://raw.githubusercontent.com/lzh19830513588-prog/uooc-video-autoplay/main/uooc-video-autoplay.user.js
// @match        *://uooc.net.cn/home/learn/*
// @match        *://*.uooc.net.cn/home/learn/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    "use strict";

    if (window.__uoocAutoplay250) return;
    window.__uoocAutoplay250 = true;

    const SPEED = 2;
    const MUTE = true;
    const completedHere = new Set();
    let activeVideo = null;
    let activeHash = "";
    let manualPaused = false;
    let lastPlayAttempt = 0;
    let lastMessage = "";

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    function status(message, error = false) {
        if (message !== lastMessage) {
            (error ? console.error : console.log)("[UOOC]", message);
            lastMessage = message;
        }
        let badge = document.getElementById("uooc-autoplay-status-250");
        if (!badge && document.body) {
            badge = document.createElement("div");
            badge.id = "uooc-autoplay-status-250";
            Object.assign(badge.style, {
                position: "fixed", top: "8px", left: "8px", zIndex: "2147483647",
                padding: "5px 9px", borderRadius: "5px", font: "12px sans-serif",
                color: "white", pointerEvents: "none", maxWidth: "55vw"
            });
            document.body.appendChild(badge);
        }
        if (badge) {
            badge.style.background = error ? "#a32626" : "#195c40";
            badge.textContent = `UOOC：${message}`;
        }
    }

    async function waitFor(read, timeout, label) {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            const value = read();
            if (value) return value;
            await sleep(250);
        }
        throw new Error(label);
    }

    function hashInfo() {
        const parts = location.hash.replace(/^#\/?/, "").split("/");
        if (parts.length < 5 || parts[4] !== "section") return null;
        return { courseId: parts[0], chapterId: parts[1], sectionId: parts[2], sourceId: parts[3] };
    }

    function sameId(a, b) {
        return a != null && b != null && String(a) === String(b);
    }

    function sourceId(source) {
        return source?.id ?? source?.sourceId ?? null;
    }

    function getChapterList() {
        if (!window.angular) return null;
        const candidates = [
            document.querySelector(".basic.active"),
            document.querySelector(".basic"),
            document.querySelector(".learn-main-left"),
            document.querySelector(".rank-1")
        ];
        for (const element of candidates) {
            if (!element) continue;
            try {
                let scope = angular.element(element).scope() || angular.element(element).isolateScope();
                for (let depth = 0; scope && depth < 20; depth++, scope = scope.$parent) {
                    if (Array.isArray(scope.chapterList)) return scope.chapterList;
                }
            } catch { /* Angular 仍在加载，稍后重试 */ }
        }
        return null;
    }

    function courseVideos() {
        const chapters = getChapterList();
        if (!chapters) return null;
        const videos = [];
        function walk(nodes, chapterId) {
            for (const section of nodes || []) {
                if (Array.isArray(section.children)) walk(section.children, chapterId);
                const sources = (section.unitSource || []).filter(s => String(s.type) === "10");
                const icons = sources.length ? sources : (section.icon_list || []).filter(s => String(s.type) === "10");
                for (const item of icons) {
                    const id = sourceId(item);
                    if (id == null) continue;
                    videos.push({
                        chapterId, sectionId: section.id, sourceId: id,
                        finished: Number(section.finished) === 1 || Number(item.finished) === 1
                    });
                }
            }
        }
        for (const chapter of chapters) walk(chapter.children, chapter.id);
        return videos;
    }

    function nextUnfinished(videos, currentId) {
        if (!videos?.length) return null;
        const currentIndex = videos.findIndex(v => sameId(v.sourceId, currentId));
        const start = currentIndex < 0 ? 0 : (currentIndex + 1) % videos.length;
        for (let i = 0; i < videos.length; i++) {
            const candidate = videos[(start + i) % videos.length];
            if (!candidate.finished && !completedHere.has(String(candidate.sourceId))) return candidate;
        }
        return null;
    }

    function navigateTo(video, courseId) {
        const target = `#/${courseId}/${video.chapterId}/${video.sectionId}/${video.sourceId}/section`;
        status(`切换视频 ${video.sourceId}`);
        location.hash = target;
    }

    function currentVideo() {
        return document.getElementById("player_html5_api") ||
            document.querySelector("[source-view] [uooc-video] video");
    }

    function currentSourceAttributeId() {
        const raw = document.querySelector("div[uooc-video]")?.getAttribute("source");
        if (!raw) return null;
        try { return sourceId(JSON.parse(raw)); }
        catch { return null; }
    }

    async function waitForVideo(previous, expectedId) {
        return waitFor(() => {
            const video = currentVideo();
            if (!video || video.readyState < 1) return null;
            if (!previous) return video;
            const src = video.currentSrc || video.src || "";
            if (video !== previous.element || (src && src !== previous.src)) return video;
            if (sameId(currentSourceAttributeId(), expectedId)) return video;
            return null;
        }, 30000, "切换后没有加载出新视频");
    }

    function getPlayer(video) {
        const players = Object.values(window.videojs?.players || {});
        let fallback = null;
        for (const player of players) {
            try {
                if (!player || player.isDisposed?.()) continue;
                const element = player.el?.();
                if (!element) continue;
                if (!fallback) fallback = player;
                if (element?.contains(video)) return player;
            } catch { /* 跳过已销毁实例 */ }
        }
        return fallback;
    }

    function applyPreferences(video) {
        const player = getPlayer(video);
        try {
            if (player) {
                if (player.muted() !== MUTE) player.muted(MUTE);
                if (Math.abs(player.playbackRate() - SPEED) > 0.01) player.playbackRate(SPEED);
            }
        } catch { /* 换源时 Video.js 实例可能暂时失效 */ }
        video.muted = MUTE;
        video.defaultMuted = MUTE;
        if (video.playbackRate !== SPEED) video.playbackRate = SPEED;
    }

    function quizVisible() {
        const layer = document.getElementById("quizLayer");
        return !!layer && layer.getClientRects().length > 0 && getComputedStyle(layer).visibility !== "hidden";
    }

    function quizPageVisible() {
        const text = document.body?.innerText || "";
        return text.includes("试卷结构") && text.includes("提交试卷");
    }

    function nearEnd(video) {
        return Number.isFinite(video.duration) && video.duration > 0 &&
            video.currentTime >= video.duration - 0.75;
    }

    async function play(video) {
        applyPreferences(video);
        lastPlayAttempt = Date.now();
        const player = getPlayer(video);
        try {
            if (player) await player.play();
            else await video.play();
        } catch {
            await video.play();
        }
        await sleep(250);
        if (video.paused && !video.ended && !quizVisible()) await video.play();
    }

    // 只把用户在播放器上的真实点击或空格键视为主动暂停。
    document.addEventListener("pointerdown", event => {
        if (!event.isTrusted || !activeVideo) return;
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (target.closest(".vjs-play-control, .vjs-big-play-button") || target === activeVideo) {
            manualPaused = !activeVideo.paused;
            if (manualPaused) status("用户已暂停，点击播放可继续");
        }
    }, true);

    document.addEventListener("keydown", event => {
        if (!event.isTrusted || !activeVideo || ![" ", "k", "K"].includes(event.key)) return;
        if (event.target instanceof Element && event.target.closest("input, textarea, [contenteditable]")) return;
        manualPaused = !activeVideo.paused;
        if (manualPaused) status("用户已暂停，按播放键可继续");
    }, true);

    function guardAgainstAutoPause(video, hash) {
        const hadOwnPause = Object.prototype.hasOwnProperty.call(video, "pause");
        const originalPause = video.pause;
        const guardedPause = function (...args) {
            if (activeVideo === this && activeHash === hash && location.hash === hash &&
                !manualPaused && !this.ended && !quizVisible()) return;
            return originalPause.apply(this, args);
        };
        video.pause = guardedPause;

        const onPause = () => {
            if (activeVideo !== video || location.hash !== hash || manualPaused || video.ended || quizVisible()) return;
            if (Date.now() - lastPlayAttempt < 500) return;
            play(video).catch(error => status(`自动恢复失败：${error.message}`, true));
        };
        video.addEventListener("pause", onPause);
        return () => {
            video.removeEventListener("pause", onPause);
            if (video.pause === guardedPause) {
                if (hadOwnPause) video.pause = originalPause;
                else delete video.pause;
            }
        };
    }

    // 独立于章节遍历：即使目录读取失败，也持续设置 2 倍速并恢复非手动暂停。
    let watchdogBusy = false;
    setInterval(() => {
        if (quizPageVisible()) return;
        const video = currentVideo();
        if (!video || video.isConnected === false || video.readyState < 1) return;
        applyPreferences(video);
        if (video.ended || nearEnd(video) || quizVisible() || manualPaused ||
            (activeVideo && location.hash !== activeHash) || !video.paused || watchdogBusy) return;
        watchdogBusy = true;
        play(video)
            .catch(error => status(`恢复播放失败：${error.message}`, true))
            .finally(() => { watchdogBusy = false; });
    }, 800);

    function waitUntilFinished(video, hash) {
        return new Promise((resolve, reject) => {
            let lastTime = video.currentTime;
            let lastProgress = Date.now();
            let timer;
            const cleanup = () => {
                clearInterval(timer);
                video.removeEventListener("ended", ended);
                video.removeEventListener("error", failed);
            };
            const ended = () => { cleanup(); resolve("ended"); };
            const failed = () => { cleanup(); reject(new Error("播放器报告视频错误")); };
            video.addEventListener("ended", ended, { once: true });
            video.addEventListener("error", failed, { once: true });
            timer = setInterval(() => {
                if (video.ended) return ended();
                if (location.hash !== hash || currentVideo() !== video) {
                    cleanup();
                    resolve("changed");
                    return;
                }
                applyPreferences(video);
                if (manualPaused || quizVisible()) {
                    lastProgress = Date.now();
                    if (quizVisible()) status("遇到视频内测验，请手动完成");
                    return;
                }
                if (video.currentTime > lastTime + 0.1) {
                    lastTime = video.currentTime;
                    lastProgress = Date.now();
                    status(`播放中 ${Math.floor(video.currentTime)} 秒`);
                }
                if (video.paused && Date.now() - lastPlayAttempt > 2000) {
                    play(video).catch(error => status(`播放受阻：${error.message}`, true));
                }
                if (Date.now() - lastProgress > 45000) {
                    cleanup();
                    reject(new Error("45 秒没有播放进度，已停止自动操作"));
                }
            }, 2000);
            if (video.ended) ended();
        });
    }

    async function main() {
        status("等待课程视频");
        let previous = null;
        while (true) {
            if (quizPageVisible()) {
                status("测验页面，暂停视频连播");
                await sleep(2000);
                continue;
            }
            let info = await waitFor(() => quizPageVisible() ? "quiz" : hashInfo(), 30000, "30 秒内未进入视频小节");
            if (info === "quiz") continue;

            if (!currentVideo()) {
                status("等待播放器加载");
                const loaded = await waitFor(currentVideo, 10000, "播放器暂未出现").catch(() => null);
                if (!loaded) {
                    if (quizPageVisible()) continue;
                    const videos = await waitFor(courseVideos, 20000, "找不到课程目录");
                    const next = nextUnfinished(videos, info.sourceId);
                    if (!next) { status("没有待播放视频"); return; }
                    navigateTo(next, info.courseId);
                    info = hashInfo();
                }
            }

            const video = await waitForVideo(previous, info.sourceId);
            previous = null;
            const list = courseVideos();
            const entry = list?.find(v => sameId(v.sourceId, info.sourceId));
            if (entry?.finished || completedHere.has(String(info.sourceId))) {
                const next = nextUnfinished(list, info.sourceId);
                if (!next) { status("没有待播放视频"); return; }
                previous = { element: video, src: video.currentSrc || video.src || "" };
                navigateTo(next, info.courseId);
                continue;
            }

            activeVideo = video;
            activeHash = location.hash;
            manualPaused = false;
            const unguard = guardAgainstAutoPause(video, activeHash);
            let result;
            try {
                status(`开始视频 ${info.sourceId}`);
                await play(video);
                result = await waitUntilFinished(video, activeHash);
            } finally {
                unguard();
                activeVideo = null;
            }

            if (result === "ended" || video.ended) {
                completedHere.add(String(info.sourceId));
                status(`已播放完 ${info.sourceId}`);
                await sleep(1000);
            }
            if (quizPageVisible()) continue;
            const videos = await waitFor(courseVideos, 15000, "课程目录未加载，无法自动切换下一个视频");
            const next = nextUnfinished(videos, info.sourceId);
            if (!next) { status("没有待播放视频，已停止"); return; }
            previous = { element: video, src: video.currentSrc || video.src || "" };
            if (result !== "changed") navigateTo(next, info.courseId);
        }
    }

    main().catch(error => status(`已停止：${error.message}`, true));
})();
