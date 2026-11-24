(function () {
    'use strict';

    const PLUGIN_FLAG = '__lampaGhSyncResumeInitialized';
    if (window[PLUGIN_FLAG]) {
        return;
    }
    window[PLUGIN_FLAG] = true;

    const CONFIG = {
        COMPONENT_ID: 'gh_sync_resume',
        GITHUB_API_BASE: 'https://api.github.com',
        DEFAULT_BRANCH: 'main',
        DEFAULT_FILE_PATH: 'lampa-sync.json',
        STATE_VERSION: 1,
        MAX_CONFLICT_RETRIES: 2,
        SYNC_DEBOUNCE_MS: 12000,
        MUTATION_DEBOUNCE_MS: 220,
        ORCHESTRATOR_TIMEOUT_MS: 18000,
        PLAYBACK_ARM_TIMEOUT_MS: 20000,
        MIN_RESUME_SECONDS: 3,
        BASE64_CHUNK_SIZE: 32768
    };

    const STORAGE_KEYS = {
        TOKEN: 'gh_sync_token',
        REPO: 'gh_sync_repo',
        BRANCH: 'gh_sync_branch',
        PATH: 'gh_sync_path',
        AUTO_SYNC: 'gh_sync_auto',
        META: 'gh_sync_local_meta',
        RESUMES: 'gh_sync_local_resumes',
        FILE_VIEW: 'file_view'
    };

    const HTTP_STATUS = {
        OK: 200,
        CREATED: 201,
        UNAUTHORIZED: 401,
        FORBIDDEN: 403,
        NOT_FOUND: 404,
        CONFLICT: 409,
        UNPROCESSABLE: 422
    };

    const CSS_CLASSES = {
        STYLE_ID: 'gh-sync-resume-styles',
        BAR: 'gh-resume-bar',
        BAR_MAIN: 'gh-resume-bar__main',
        BAR_ICON: 'gh-resume-bar__icon',
        BAR_INFO: 'gh-resume-bar__info',
        BAR_TITLE: 'gh-resume-bar__title',
        BAR_META: 'gh-resume-bar__meta',
        BAR_TAG: 'gh-resume-bar__tag',
        BAR_TIME: 'gh-resume-bar__time',
        BAR_PROGRESS: 'gh-resume-bar__progress',
        BAR_PROGRESS_FILL: 'gh-resume-bar__progress-fill'
    };

    const runtime = {
        syncInProgress: false,
        syncQueued: false,
        syncDebounceTimer: null,
        isApplyingRemote: false,
        activeObserver: null,
        mutationDebounceTimer: null,
        activePlayContext: null,
        pendingPlaybackTarget: null,
        orchestrator: {
            active: false,
            target: null,
            root: null,
            attemptedSource: false,
            attemptedSeason: false,
            attemptedVoice: false,
            pendingFilterSubmenu: null,
            timerId: null
        }
    };

    function encodeUtf8ToBase64(text) {
        if (typeof TextEncoder !== 'undefined') {
            const bytes = new TextEncoder().encode(text);
            let binary = '';
            for (let i = 0; i < bytes.length; i += CONFIG.BASE64_CHUNK_SIZE) {
                const slice = bytes.subarray(i, i + CONFIG.BASE64_CHUNK_SIZE);
                binary += String.fromCharCode.apply(null, slice);
            }
            return btoa(binary);
        }
        return btoa(unescape(encodeURIComponent(text)));
    }

    function decodeBase64ToUtf8(base64) {
        const sanitized = String(base64 || '').replace(/\s+/g, '');
        if (!sanitized) {
            return '';
        }
        const binary = atob(sanitized);
        if (typeof TextDecoder !== 'undefined') {
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
                bytes[i] = binary.charCodeAt(i);
            }
            return new TextDecoder('utf-8').decode(bytes);
        }
        return decodeURIComponent(escape(binary));
    }

    function normalizeText(value) {
        return String(value || '')
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .trim();
    }

    function formatSeconds(totalSeconds) {
        const safe = Math.max(0, Math.floor(Number(totalSeconds) || 0));
        const hours = Math.floor(safe / 3600);
        const minutes = Math.floor((safe % 3600) / 60);
        const seconds = safe % 60;
        const pad = function (num) {
            return num < 10 ? '0' + num : String(num);
        };
        if (hours > 0) {
            return hours + ':' + pad(minutes) + ':' + pad(seconds);
        }
        return pad(minutes) + ':' + pad(seconds);
    }

    function padEpisodeNumber(value) {
        const num = Number(value) || 0;
        return num < 10 ? '0' + num : String(num);
    }

    function maskSecret(secret) {
        const str = String(secret || '').trim();
        if (!str) {
            return 'Не задан';
        }
        if (str.length <= 8) {
            return '********';
        }
        return str.slice(0, 4) + '••••••••' + str.slice(-4);
    }

    function getSafeObjectStorage(key) {
        const raw = Lampa.Storage.get(key, {});
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
            return raw;
        }
        return {};
    }

    function getSyncCredentials() {
        const token = String(Lampa.Storage.get(STORAGE_KEYS.TOKEN, '')).trim();
        const repoRaw = String(Lampa.Storage.get(STORAGE_KEYS.REPO, '')).trim().replace(/^\/+|\/+$/g, '');
        const branch = String(Lampa.Storage.get(STORAGE_KEYS.BRANCH, CONFIG.DEFAULT_BRANCH)).trim() || CONFIG.DEFAULT_BRANCH;
        const filePath = String(Lampa.Storage.get(STORAGE_KEYS.PATH, CONFIG.DEFAULT_FILE_PATH)).trim().replace(/^\/+/, '') || CONFIG.DEFAULT_FILE_PATH;
        const parts = repoRaw.split('/');
        const validRepo = parts.length === 2 && Boolean(parts[0]) && Boolean(parts[1]);
        return {
            token: token,
            owner: validRepo ? parts[0] : '',
            repo: validRepo ? parts[1] : '',
            branch: branch,
            filePath: filePath,
            isValid: Boolean(token && validRepo)
        };
    }

    function isAutoSyncEnabled() {
        return Lampa.Storage.get(STORAGE_KEYS.AUTO_SYNC, true) !== false;
    }

    function buildContentsEndpoint(creds) {
        const encodedPath = creds.filePath.split('/').map(encodeURIComponent).join('/');
        return CONFIG.GITHUB_API_BASE + '/repos/' + encodeURIComponent(creds.owner) + '/' + encodeURIComponent(creds.repo) + '/contents/' + encodedPath;
    }

    function createEmptyState() {
        return {
            version: CONFIG.STATE_VERSION,
            updatedAt: 0,
            timelines: {},
            resumes: {}
        };
    }

    function normalizeTimelineEntry(hash, entry, fallbackTimestamp) {
        if (!hash || !entry || typeof entry !== 'object') {
            return null;
        }
        const time = Math.max(0, Number(entry.time) || 0);
        const duration = Math.max(0, Number(entry.duration) || 0);
        let percent = Math.max(0, Math.min(100, Number(entry.percent) || 0));
        if (percent === 0 && duration > 0 && time > 0) {
            percent = Math.min(100, Math.round((time / duration) * 100));
        }
        const updatedAt = Number(entry.updatedAt) || Number(fallbackTimestamp) || 0;
        return {
            hash: String(hash),
            time: Math.floor(time),
            duration: Math.floor(duration),
            percent: percent,
            updatedAt: updatedAt
        };
    }

    function normalizeResumeEntry(movieKey, entry) {
        if (!movieKey || !entry || typeof entry !== 'object') {
            return null;
        }
        const time = Math.max(0, Math.floor(Number(entry.time) || 0));
        const duration = Math.max(0, Math.floor(Number(entry.duration) || 0));
        let percent = Math.max(0, Math.min(100, Number(entry.percent) || 0));
        if (percent === 0 && duration > 0 && time > 0) {
            percent = Math.min(100, Math.round((time / duration) * 100));
        }
        return {
            movieKey: String(movieKey),
            mediaType: entry.mediaType === 'movie' ? 'movie' : 'tv',
            season: Math.max(0, Number(entry.season) || 0),
            episode: Math.max(0, Number(entry.episode) || 0),
            episodeTitle: String(entry.episodeTitle || '').trim(),
            source: String(entry.source || '').trim(),
            voice: String(entry.voice || '').trim(),
            quality: String(entry.quality || '').trim(),
            component: String(entry.component || '').trim(),
            timelineHash: String(entry.timelineHash || '').trim(),
            time: time,
            duration: duration,
            percent: percent,
            updatedAt: Number(entry.updatedAt) || 0
        };
    }

    function buildLocalStateSnapshot() {
        const fileView = getSafeObjectStorage(STORAGE_KEYS.FILE_VIEW);
        const localMeta = getSafeObjectStorage(STORAGE_KEYS.META);
        const localResumes = getSafeObjectStorage(STORAGE_KEYS.RESUMES);
        const state = createEmptyState();
        let maxTimestamp = 0;

        Object.keys(fileView).forEach(function (hash) {
            const normalized = normalizeTimelineEntry(hash, fileView[hash], localMeta[hash]);
            if (!normalized) {
                return;
            }
            state.timelines[hash] = normalized;
            if (normalized.updatedAt > maxTimestamp) {
                maxTimestamp = normalized.updatedAt;
            }
        });

        Object.keys(localResumes).forEach(function (movieKey) {
            const normalized = normalizeResumeEntry(movieKey, localResumes[movieKey]);
            if (!normalized) {
                return;
            }
            state.resumes[movieKey] = normalized;
            if (normalized.updatedAt > maxTimestamp) {
                maxTimestamp = normalized.updatedAt;
            }
        });

        state.updatedAt = maxTimestamp;
        return state;
    }

    function pickNewerTimeline(localEntry, remoteEntry) {
        if (!localEntry) {
            return remoteEntry;
        }
        if (!remoteEntry) {
            return localEntry;
        }
        if (remoteEntry.updatedAt > localEntry.updatedAt) {
            return remoteEntry;
        }
        if (localEntry.updatedAt > remoteEntry.updatedAt) {
            return localEntry;
        }
        if (remoteEntry.percent > localEntry.percent || remoteEntry.time > localEntry.time) {
            return remoteEntry;
        }
        return localEntry;
    }

    function pickNewerResume(localEntry, remoteEntry) {
        if (!localEntry) {
            return remoteEntry;
        }
        if (!remoteEntry) {
            return localEntry;
        }
        if (remoteEntry.updatedAt > localEntry.updatedAt) {
            return remoteEntry;
        }
        if (localEntry.updatedAt > remoteEntry.updatedAt) {
            return localEntry;
        }
        return localEntry.time >= remoteEntry.time ? localEntry : remoteEntry;
    }

    function mergeSyncStates(localState, remoteState) {
        const merged = createEmptyState();
        let remoteNeedsUpdate = false;
        let localNeedsUpdate = false;
        let maxTimestamp = 0;

        const allTimelineHashes = Object.keys(Object.assign({}, localState.timelines, remoteState.timelines));
        allTimelineHashes.forEach(function (hash) {
            const localEntry = normalizeTimelineEntry(hash, localState.timelines[hash], 0);
            const remoteEntry = normalizeTimelineEntry(hash, remoteState.timelines[hash], 0);
            const winner = pickNewerTimeline(localEntry, remoteEntry);
            if (!winner) {
                return;
            }
            merged.timelines[hash] = winner;
            if (winner.updatedAt > maxTimestamp) {
                maxTimestamp = winner.updatedAt;
            }
            if (!remoteEntry || remoteEntry.time !== winner.time || remoteEntry.percent !== winner.percent || remoteEntry.updatedAt !== winner.updatedAt) {
                remoteNeedsUpdate = true;
            }
            if (!localEntry || localEntry.time !== winner.time || localEntry.percent !== winner.percent) {
                localNeedsUpdate = true;
            }
        });

        const allResumeKeys = Object.keys(Object.assign({}, localState.resumes, remoteState.resumes));
        allResumeKeys.forEach(function (movieKey) {
            const localEntry = normalizeResumeEntry(movieKey, localState.resumes[movieKey]);
            const remoteEntry = normalizeResumeEntry(movieKey, remoteState.resumes[movieKey]);
            const winner = pickNewerResume(localEntry, remoteEntry);
            if (!winner) {
                return;
            }
            merged.resumes[movieKey] = winner;
            if (winner.updatedAt > maxTimestamp) {
                maxTimestamp = winner.updatedAt;
            }
            if (!remoteEntry || JSON.stringify(remoteEntry) !== JSON.stringify(winner)) {
                remoteNeedsUpdate = true;
            }
            if (!localEntry || JSON.stringify(localEntry) !== JSON.stringify(winner)) {
                localNeedsUpdate = true;
            }
        });

        merged.updatedAt = maxTimestamp || Date.now();
        return {
            mergedState: merged,
            remoteNeedsUpdate: remoteNeedsUpdate,
            localNeedsUpdate: localNeedsUpdate
        };
    }

    function applyMergedStateLocally(mergedState) {
        runtime.isApplyingRemote = true;
        try {
            const fileView = getSafeObjectStorage(STORAGE_KEYS.FILE_VIEW);
            const localMeta = getSafeObjectStorage(STORAGE_KEYS.META);

            Object.keys(mergedState.timelines).forEach(function (hash) {
                const entry = mergedState.timelines[hash];
                fileView[hash] = {
                    hash: entry.hash,
                    time: entry.time,
                    duration: entry.duration,
                    percent: entry.percent
                };
                localMeta[hash] = entry.updatedAt;
                if (Lampa.Timeline && typeof Lampa.Timeline.update === 'function') {
                    Lampa.Timeline.update({
                        hash: entry.hash,
                        time: entry.time,
                        duration: entry.duration,
                        percent: entry.percent
                    });
                }
            });

            Lampa.Storage.set(STORAGE_KEYS.FILE_VIEW, fileView);
            Lampa.Storage.set(STORAGE_KEYS.META, localMeta);
            Lampa.Storage.set(STORAGE_KEYS.RESUMES, mergedState.resumes);
        } finally {
            runtime.isApplyingRemote = false;
        }
    }

    async function fetchRemoteFile(creds) {
        const url = buildContentsEndpoint(creds) + '?ref=' + encodeURIComponent(creds.branch);
        const response = await fetch(url, {
            method: 'GET',
            cache: 'no-store',
            headers: {
                Authorization: 'Bearer ' + creds.token,
                Accept: 'application/vnd.github+json'
            }
        });

        if (response.status === HTTP_STATUS.NOT_FOUND) {
            return {
                exists: false,
                sha: null,
                state: createEmptyState()
            };
        }

        if (!response.ok) {
            throw new Error('GitHub GET HTTP ' + response.status);
        }

        const payload = await response.json();
        const decoded = decodeBase64ToUtf8(payload.content || '');
        let parsed = createEmptyState();
        if (decoded) {
            try {
                const rawJson = JSON.parse(decoded);
                if (rawJson && typeof rawJson === 'object') {
                    parsed = {
                        version: Number(rawJson.version) || CONFIG.STATE_VERSION,
                        updatedAt: Number(rawJson.updatedAt) || 0,
                        timelines: rawJson.timelines && typeof rawJson.timelines === 'object' ? rawJson.timelines : {},
                        resumes: rawJson.resumes && typeof rawJson.resumes === 'object' ? rawJson.resumes : {}
                    };
                }
            } catch (parseError) {
                console.error('[GH Sync] Invalid remote JSON', parseError);
            }
        }

        return {
            exists: true,
            sha: payload.sha || null,
            state: parsed
        };
    }

    async function pushRemoteFile(creds, state, remoteSha) {
        const url = buildContentsEndpoint(creds);
        const body = {
            message: 'Sync Lampa timelines ' + new Date().toISOString(),
            content: encodeUtf8ToBase64(JSON.stringify(state)),
            branch: creds.branch
        };
        if (remoteSha) {
            body.sha = remoteSha;
        }

        const response = await fetch(url, {
            method: 'PUT',
            cache: 'no-store',
            headers: {
                Authorization: 'Bearer ' + creds.token,
                Accept: 'application/vnd.github+json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });

        if (response.status === HTTP_STATUS.CONFLICT || response.status === HTTP_STATUS.UNPROCESSABLE) {
            const conflictError = new Error('GitHub SHA conflict');
            conflictError.isConflict = true;
            throw conflictError;
        }

        if (!response.ok) {
            throw new Error('GitHub PUT HTTP ' + response.status);
        }
    }

    async function executeSync(options) {
        const notify = Boolean(options && options.notify);
        const creds = getSyncCredentials();
        if (!creds.isValid) {
            if (notify) {
                Lampa.Noty.show('GitHub Sync: укажите токен и репозиторий (user/repo)');
            }
            return false;
        }

        if (runtime.syncInProgress) {
            runtime.syncQueued = true;
            return false;
        }

        runtime.syncInProgress = true;
        try {
            let attempt = 0;
            while (attempt <= CONFIG.MAX_CONFLICT_RETRIES) {
                attempt += 1;
                try {
                    const remote = await fetchRemoteFile(creds);
                    const localState = buildLocalStateSnapshot();
                    const result = mergeSyncStates(localState, remote.state);

                    if (result.localNeedsUpdate) {
                        applyMergedStateLocally(result.mergedState);
                        refreshCurrentResumeBar();
                    }

                    if (!remote.exists || result.remoteNeedsUpdate) {
                        await pushRemoteFile(creds, result.mergedState, remote.sha);
                    }

                    if (notify) {
                        const resumeCount = Object.keys(result.mergedState.resumes).length;
                        const timelineCount = Object.keys(result.mergedState.timelines).length;
                        Lampa.Noty.show('GitHub Sync: синхронизировано (таймкоды: ' + timelineCount + ', позиции: ' + resumeCount + ')');
                    }
                    return true;
                } catch (err) {
                    if (err && err.isConflict && attempt <= CONFIG.MAX_CONFLICT_RETRIES) {
                        continue;
                    }
                    throw err;
                }
            }
            return false;
        } catch (error) {
            console.error('[GH Sync] Sync failed', error);
            if (notify) {
                Lampa.Noty.show('GitHub Sync ошибка: ' + (error && error.message ? error.message : 'нет связи'));
            }
            return false;
        } finally {
            runtime.syncInProgress = false;
            if (runtime.syncQueued) {
                runtime.syncQueued = false;
                scheduleDebouncedSync();
            }
        }
    }

    function scheduleDebouncedSync() {
        if (!isAutoSyncEnabled() || !getSyncCredentials().isValid) {
            return;
        }
        if (runtime.syncDebounceTimer) {
            clearTimeout(runtime.syncDebounceTimer);
        }
        runtime.syncDebounceTimer = setTimeout(function () {
            runtime.syncDebounceTimer = null;
            executeSync({ notify: false });
        }, CONFIG.SYNC_DEBOUNCE_MS);
    }

    async function testGitHubConnection() {
        const creds = getSyncCredentials();
        if (!creds.isValid) {
            Lampa.Noty.show('GitHub Sync: заполните токен и репозиторий');
            return;
        }
        try {
            const repoUrl = CONFIG.GITHUB_API_BASE + '/repos/' + encodeURIComponent(creds.owner) + '/' + encodeURIComponent(creds.repo);
            const response = await fetch(repoUrl, {
                method: 'GET',
                cache: 'no-store',
                headers: {
                    Authorization: 'Bearer ' + creds.token,
                    Accept: 'application/vnd.github+json'
                }
            });
            if (response.status === HTTP_STATUS.UNAUTHORIZED || response.status === HTTP_STATUS.FORBIDDEN) {
                Lampa.Noty.show('GitHub Sync: токен отклонён (HTTP ' + response.status + ')');
                return;
            }
            if (response.status === HTTP_STATUS.NOT_FOUND) {
                Lampa.Noty.show('GitHub Sync: репозиторий не найден или нет доступа');
                return;
            }
            if (!response.ok) {
                Lampa.Noty.show('GitHub Sync: ошибка сервера (HTTP ' + response.status + ')');
                return;
            }
            Lampa.Noty.show('GitHub Sync: подключение успешно (' + creds.owner + '/' + creds.repo + ')');
        } catch (error) {
            console.error('[GH Sync] Connection test error', error);
            Lampa.Noty.show('GitHub Sync: ошибка сети');
        }
    }

    function getActiveMovieDescriptor() {
        if (!Lampa.Activity || typeof Lampa.Activity.active !== 'function') {
            return null;
        }
        const active = Lampa.Activity.active();
        if (!active) {
            return null;
        }
        const movie = active.movie || active.card || (active.object && (active.object.movie || active.object.card));
        if (!movie || !movie.id) {
            return null;
        }
        const isSeries = Boolean(movie.name || movie.original_name || movie.first_air_date || movie.number_of_seasons);
        const mediaType = isSeries ? 'tv' : 'movie';
        return {
            movieKey: mediaType + '_' + String(movie.id),
            mediaType: mediaType,
            movie: movie,
            component: String(active.component || ''),
            activity: active.activity || null
        };
    }

    function getActiveRenderRoot() {
        if (!Lampa.Activity || typeof Lampa.Activity.active !== 'function') {
            return null;
        }
        const active = Lampa.Activity.active();
        if (!active || !active.activity || typeof active.activity.render !== 'function') {
            return null;
        }
        const rendered = active.activity.render();
        if (!rendered) {
            return null;
        }
        return rendered[0] || rendered;
    }

    function findFilterButtonByKeywords(root, primaryClass, keywords) {
        if (!root) {
            return null;
        }
        const direct = root.querySelector('.' + primaryClass);
        if (direct) {
            return direct;
        }
        const buttons = root.querySelectorAll('.simple-button--filter, .filter--sort, .filter--filter, .online-filter');
        for (let i = 0; i < buttons.length; i++) {
            const label = normalizeText(buttons[i].textContent);
            for (let j = 0; j < keywords.length; j++) {
                if (label.indexOf(keywords[j]) !== -1) {
                    return buttons[i];
                }
            }
        }
        return null;
    }

    function readFilterButtonValue(button) {
        if (!button) {
            return '';
        }
        const valueNode = button.querySelector('div, .simple-button__value, .filter-button__value');
        if (valueNode && valueNode.textContent) {
            return valueNode.textContent.trim();
        }
        const spans = button.querySelectorAll('span');
        if (spans.length > 1) {
            return spans[spans.length - 1].textContent.trim();
        }
        return '';
    }

    function readCurrentDomContext(root) {
        const sourceButton = findFilterButtonByKeywords(root, 'filter--sort', ['источник', 'балансер', 'source']);
        const filterButton = findFilterButtonByKeywords(root, 'filter--filter', ['фильтр', 'filter', 'озвуч', 'сезон']);
        const source = readFilterButtonValue(sourceButton);
        const filterText = readFilterButtonValue(filterButton);
        const parsedFilter = parseFilterSummary(filterText);
        return {
            source: source,
            season: parsedFilter.season,
            voice: parsedFilter.voice,
            rawFilter: filterText,
            sourceButton: sourceButton,
            filterButton: filterButton
        };
    }

    function parseFilterSummary(filterText) {
        const result = { season: 0, voice: '' };
        if (!filterText) {
            return result;
        }
        const parts = filterText.split(',').map(function (part) {
            return part.trim();
        }).filter(Boolean);

        parts.forEach(function (part) {
            const seasonMatch = part.match(/(?:сезон|season|s)\s*(\d+)/i);
            if (seasonMatch) {
                result.season = Number(seasonMatch[1]) || 0;
                return;
            }
            if (!result.voice && !/^(?:все|all|выбрать|качество|\d+p)$/i.test(part)) {
                result.voice = part;
            }
        });
        return result;
    }

    function parseSeasonEpisodeFromText(text) {
        const str = String(text || '');
        let season = 0;
        let episode = 0;

        const seMatch = str.match(/s(\d{1,2})\s*e(\d{1,3})/i);
        if (seMatch) {
            return { season: Number(seMatch[1]) || 0, episode: Number(seMatch[2]) || 0 };
        }
        const seasonMatch = str.match(/(?:сезон|season)\s*(\d{1,2})/i);
        if (seasonMatch) {
            season = Number(seasonMatch[1]) || 0;
        }
        const episodeMatch = str.match(/(?:серия|эпизод|episode|ep\.?)\s*(\d{1,3})/i);
        if (episodeMatch) {
            episode = Number(episodeMatch[1]) || 0;
        }
        return { season: season, episode: episode };
    }

    function detectQualityLabel(playData) {
        if (!playData || typeof playData !== 'object') {
            return '';
        }
        if (playData.quality && typeof playData.quality === 'object') {
            const keys = Object.keys(playData.quality);
            for (let i = 0; i < keys.length; i++) {
                if (playData.quality[keys[i]] === playData.url) {
                    return String(keys[i]).trim();
                }
            }
            if (keys.length > 0) {
                return String(keys[0]).trim();
            }
        }
        const defaultQuality = Lampa.Storage.get('video_quality_default', '');
        return defaultQuality ? String(defaultQuality) + 'p' : '';
    }

    function matchQualityKey(qualityMap, targetQuality) {
        if (!qualityMap || typeof qualityMap !== 'object' || !targetQuality) {
            return null;
        }
        const targetNorm = normalizeText(targetQuality).replace(/p$/i, '');
        const keys = Object.keys(qualityMap);
        for (let i = 0; i < keys.length; i++) {
            const keyNorm = normalizeText(keys[i]).replace(/p$/i, '');
            if (keyNorm === targetNorm || keyNorm.indexOf(targetNorm) !== -1 || targetNorm.indexOf(keyNorm) !== -1) {
                return keys[i];
            }
        }
        return null;
    }

    function saveLocalResume(entry) {
        const normalized = normalizeResumeEntry(entry.movieKey, entry);
        if (!normalized) {
            return;
        }
        const resumes = getSafeObjectStorage(STORAGE_KEYS.RESUMES);
        resumes[normalized.movieKey] = normalized;
        Lampa.Storage.set(STORAGE_KEYS.RESUMES, resumes);
    }

    function updateLocalTimelineMeta(hash, timestamp) {
        if (!hash) {
            return;
        }
        const meta = getSafeObjectStorage(STORAGE_KEYS.META);
        meta[hash] = timestamp;
        Lampa.Storage.set(STORAGE_KEYS.META, meta);
    }

    function capturePlaybackContext(playData) {
        const descriptor = getActiveMovieDescriptor();
        if (!descriptor) {
            runtime.activePlayContext = null;
            return;
        }

        const root = getActiveRenderRoot();
        const domCtx = readCurrentDomContext(root);
        const parsedTitle = parseSeasonEpisodeFromText(playData.title || '');

        const season = Number(playData.season || playData.s || parsedTitle.season || domCtx.season || 0);
        const episode = Number(playData.episode || playData.e || parsedTitle.episode || 0);
        const voice = String(playData.voice_name || playData.translate || playData.voice || domCtx.voice || '').trim();
        const source = String(domCtx.source || Lampa.Storage.get('online_mod_balanser', '') || Lampa.Storage.get('online_balanser', '') || '').trim();
        const quality = detectQualityLabel(playData);
        const timelineHash = playData.timeline && playData.timeline.hash ? String(playData.timeline.hash) : '';
        const episodeTitle = String(playData.title || '').trim();

        runtime.activePlayContext = {
            movieKey: descriptor.movieKey,
            mediaType: descriptor.mediaType,
            season: season,
            episode: episode,
            episodeTitle: episodeTitle,
            source: source,
            voice: voice,
            quality: quality,
            component: descriptor.component,
            timelineHash: timelineHash
        };

        const existingTimeline = timelineHash && Lampa.Timeline && typeof Lampa.Timeline.view === 'function'
            ? Lampa.Timeline.view(timelineHash)
            : null;
        const initialTime = existingTimeline ? Number(existingTimeline.time) || 0 : 0;
        const initialDuration = existingTimeline ? Number(existingTimeline.duration) || 0 : 0;
        const initialPercent = existingTimeline ? Number(existingTimeline.percent) || 0 : 0;

        saveLocalResume(Object.assign({}, runtime.activePlayContext, {
            time: initialTime,
            duration: initialDuration,
            percent: initialPercent,
            updatedAt: Date.now()
        }));
    }

    function handleTimelineRecordUpdate(data) {
        if (runtime.isApplyingRemote || !data || !data.hash) {
            return;
        }
        const now = Date.now();
        updateLocalTimelineMeta(String(data.hash), now);

        const ctx = runtime.activePlayContext;
        if (ctx && (!ctx.timelineHash || ctx.timelineHash === String(data.hash))) {
            saveLocalResume(Object.assign({}, ctx, {
                timelineHash: String(data.hash),
                time: Math.floor(Number(data.time) || 0),
                duration: Math.floor(Number(data.duration) || 0),
                percent: Math.max(0, Math.min(100, Number(data.percent) || 0)),
                updatedAt: now
            }));
        }

        scheduleDebouncedSync();
    }

    function installPlayerPlayInterceptor() {
        if (!Lampa.Player || typeof Lampa.Player.play !== 'function') {
            return;
        }
        const originalPlay = Lampa.Player.play.bind(Lampa.Player);
        Lampa.Player.play = function (playData) {
            if (playData && typeof playData === 'object') {
                const pending = runtime.pendingPlaybackTarget;
                if (pending && Date.now() <= pending.expiresAt) {
                    runtime.pendingPlaybackTarget = null;
                    if (pending.quality && playData.quality && typeof playData.quality === 'object') {
                        const matchedKey = matchQualityKey(playData.quality, pending.quality);
                        if (matchedKey && playData.quality[matchedKey]) {
                            playData.url = playData.quality[matchedKey];
                        }
                    }
                    if (pending.time >= CONFIG.MIN_RESUME_SECONDS) {
                        const targetHash = (playData.timeline && playData.timeline.hash) || pending.timelineHash || '';
                        if (targetHash) {
                            const injectedTimeline = {
                                hash: targetHash,
                                time: pending.time,
                                duration: pending.duration,
                                percent: pending.percent
                            };
                            playData.timeline = Object.assign({}, playData.timeline || {}, injectedTimeline);
                            runtime.isApplyingRemote = true;
                            try {
                                if (Lampa.Timeline && typeof Lampa.Timeline.update === 'function') {
                                    Lampa.Timeline.update(injectedTimeline);
                                }
                            } finally {
                                runtime.isApplyingRemote = false;
                            }
                        }
                    }
                }
                capturePlaybackContext(playData);
            }
            return originalPlay(playData);
        };
    }

    function stopOrchestrator() {
        if (runtime.orchestrator.timerId) {
            clearTimeout(runtime.orchestrator.timerId);
            runtime.orchestrator.timerId = null;
        }
        runtime.orchestrator.active = false;
        runtime.orchestrator.target = null;
        runtime.orchestrator.root = null;
        runtime.orchestrator.attemptedSource = false;
        runtime.orchestrator.attemptedSeason = false;
        runtime.orchestrator.attemptedVoice = false;
        runtime.orchestrator.pendingFilterSubmenu = null;
    }

    function abortOrchestrator(reason) {
        stopOrchestrator();
        runtime.pendingPlaybackTarget = null;
        if (reason) {
            Lampa.Noty.show('GitHub Sync: ' + reason);
        }
    }

    function findMatchingSelectItem(items, expectedText, expectedSeason) {
        if (!Array.isArray(items)) {
            return null;
        }
        const targetNorm = normalizeText(expectedText);

        if (expectedSeason > 0) {
            for (let i = 0; i < items.length; i++) {
                const title = String(items[i].title || '');
                const match = title.match(/(?:сезон|season)\s*(\d+)/i) || title.match(/^\s*(\d+)\s*$/);
                if (match && Number(match[1]) === expectedSeason) {
                    return items[i];
                }
            }
        }

        if (!targetNorm) {
            return null;
        }

        for (let i = 0; i < items.length; i++) {
            if (normalizeText(items[i].title) === targetNorm) {
                return items[i];
            }
        }

        for (let i = 0; i < items.length; i++) {
            const candidate = normalizeText(items[i].title);
            if (candidate && (candidate.indexOf(targetNorm) !== -1 || targetNorm.indexOf(candidate) !== -1)) {
                return items[i];
            }
        }
        return null;
    }

    function installSelectInterceptor() {
        if (!Lampa.Select || typeof Lampa.Select.show !== 'function') {
            return;
        }
        const originalShow = Lampa.Select.show.bind(Lampa.Select);
        Lampa.Select.show = function (params) {
            const orch = runtime.orchestrator;
            if (!orch.active || !orch.target || !params || !Array.isArray(params.items)) {
                return originalShow(params);
            }

            const items = params.items;
            const onSelect = typeof params.onSelect === 'function' ? params.onSelect : null;
            if (!onSelect) {
                return originalShow(params);
            }

            if (orch.pendingFilterSubmenu === 'SOURCE') {
                orch.pendingFilterSubmenu = null;
                const matchedSource = findMatchingSelectItem(items, orch.target.source, 0);
                if (!matchedSource) {
                    abortOrchestrator('источник «' + orch.target.source + '» не найден');
                    return;
                }
                setTimeout(function () {
                    onSelect(matchedSource);
                }, 0);
                return;
            }

            const hasSubitems = items.some(function (item) {
                return Array.isArray(item.subitems);
            });

            if (hasSubitems) {
                if (orch.pendingFilterSubmenu === 'SEASON') {
                    const seasonMenu = findMatchingSelectItem(items, 'сезон', 0);
                    if (seasonMenu) {
                        setTimeout(function () {
                            onSelect(seasonMenu);
                        }, 0);
                        return;
                    }
                }
                if (orch.pendingFilterSubmenu === 'VOICE') {
                    const voiceMenu = findMatchingSelectItem(items, 'озвуч', 0) || findMatchingSelectItem(items, 'перевод', 0);
                    if (voiceMenu) {
                        setTimeout(function () {
                            onSelect(voiceMenu);
                        }, 0);
                        return;
                    }
                }
                abortOrchestrator('нужный пункт фильтра не найден');
                return;
            }

            if (orch.pendingFilterSubmenu === 'SEASON') {
                orch.pendingFilterSubmenu = null;
                const matchedSeason = findMatchingSelectItem(items, 'сезон ' + orch.target.season, orch.target.season);
                if (!matchedSeason) {
                    abortOrchestrator('сезон ' + orch.target.season + ' не найден');
                    return;
                }
                setTimeout(function () {
                    onSelect(matchedSeason);
                }, 0);
                return;
            }

            if (orch.pendingFilterSubmenu === 'VOICE') {
                orch.pendingFilterSubmenu = null;
                const matchedVoice = findMatchingSelectItem(items, orch.target.voice, 0);
                if (!matchedVoice) {
                    abortOrchestrator('озвучка «' + orch.target.voice + '» не найдена');
                    return;
                }
                setTimeout(function () {
                    onSelect(matchedVoice);
                }, 0);
                return;
            }

            return originalShow(params);
        };
    }

    function triggerLampaElement(element) {
        if (!element) {
            return;
        }
        if (window.$) {
            window.$(element).trigger('hover:enter');
            return;
        }
        element.click();
    }

    function findEpisodeCardInDom(root, resume) {
        if (!root || !resume) {
            return null;
        }
        const scrollBody = root.querySelector('.scroll__body');
        if (!scrollBody) {
            return null;
        }
        const cards = scrollBody.querySelectorAll('.online-prestige, .online, .selector');
        const candidates = [];
        for (let i = 0; i < cards.length; i++) {
            const card = cards[i];
            if (card.classList.contains(CSS_CLASSES.BAR) || card.closest('.' + CSS_CLASSES.BAR)) {
                continue;
            }
            if (card.closest('.filter')) {
                continue;
            }
            candidates.push(card);
        }

        if (candidates.length === 0) {
            return null;
        }

        if (resume.mediaType === 'movie' && resume.episode === 0) {
            const targetVoiceNorm = normalizeText(resume.voice);
            if (targetVoiceNorm) {
                for (let i = 0; i < candidates.length; i++) {
                    if (normalizeText(candidates[i].textContent).indexOf(targetVoiceNorm) !== -1) {
                        return candidates[i];
                    }
                }
            }
            return candidates[0];
        }

        const targetEp = Number(resume.episode) || 0;
        const targetEpPadded = padEpisodeNumber(targetEp);
        const targetTitleNorm = normalizeText(resume.episodeTitle);

        for (let i = 0; i < candidates.length; i++) {
            const card = candidates[i];
            const numNode = card.querySelector('.online-prestige__episode-number, .online__episode-number, .online-prestige__num');
            if (numNode) {
                const rawNum = Number(String(numNode.textContent || '').replace(/\D+/g, ''));
                if (rawNum === targetEp && targetEp > 0) {
                    return card;
                }
            }
        }

        for (let i = 0; i < candidates.length; i++) {
            const text = String(candidates[i].textContent || '');
            const parsed = parseSeasonEpisodeFromText(text);
            if (targetEp > 0 && parsed.episode === targetEp && (!resume.season || !parsed.season || parsed.season === resume.season)) {
                return candidates[i];
            }
            if (targetEp > 0 && new RegExp('(?:^|\\s)(?:' + targetEpPadded + '|' + targetEp + ')(?:\\s|$)').test(text.slice(0, 12))) {
                return candidates[i];
            }
        }

        if (targetTitleNorm) {
            for (let i = 0; i < candidates.length; i++) {
                if (normalizeText(candidates[i].textContent).indexOf(targetTitleNorm) !== -1) {
                    return candidates[i];
                }
            }
        }

        return null;
    }

    function advanceOrchestrator() {
        const orch = runtime.orchestrator;
        if (!orch.active || !orch.target) {
            return;
        }
        const root = getActiveRenderRoot();
        if (!root) {
            return;
        }
        orch.root = root;

        const target = orch.target;
        const domCtx = readCurrentDomContext(root);

        if (
            target.source &&
            domCtx.sourceButton &&
            !orch.attemptedSource &&
            normalizeText(domCtx.source) !== normalizeText(target.source)
        ) {
            orch.attemptedSource = true;
            orch.pendingFilterSubmenu = 'SOURCE';
            triggerLampaElement(domCtx.sourceButton);
            return;
        }

        if (
            target.season > 0 &&
            domCtx.filterButton &&
            !orch.attemptedSeason &&
            domCtx.season > 0 &&
            domCtx.season !== target.season
        ) {
            orch.attemptedSeason = true;
            orch.pendingFilterSubmenu = 'SEASON';
            triggerLampaElement(domCtx.filterButton);
            return;
        }

        if (
            target.voice &&
            domCtx.filterButton &&
            !orch.attemptedVoice &&
            normalizeText(domCtx.voice) &&
            normalizeText(domCtx.voice).indexOf(normalizeText(target.voice)) === -1
        ) {
            orch.attemptedVoice = true;
            orch.pendingFilterSubmenu = 'VOICE';
            triggerLampaElement(domCtx.filterButton);
            return;
        }

        const matchedCard = findEpisodeCardInDom(root, target);
        if (!matchedCard) {
            return;
        }

        runtime.pendingPlaybackTarget = {
            time: target.time,
            duration: target.duration,
            percent: target.percent,
            quality: target.quality,
            timelineHash: target.timelineHash,
            expiresAt: Date.now() + CONFIG.PLAYBACK_ARM_TIMEOUT_MS
        };

        stopOrchestrator();
        triggerLampaElement(matchedCard);
    }

    function startResumeOrchestration(resume) {
        if (!resume) {
            return;
        }
        stopOrchestrator();
        runtime.orchestrator.active = true;
        runtime.orchestrator.target = resume;
        runtime.orchestrator.timerId = setTimeout(function () {
            abortOrchestrator('не удалось автоматически открыть серию');
        }, CONFIG.ORCHESTRATOR_TIMEOUT_MS);

        const label = resume.mediaType === 'tv' && resume.episode > 0
            ? 'S' + padEpisodeNumber(resume.season || 1) + 'E' + padEpisodeNumber(resume.episode)
            : 'Фильм';
        Lampa.Noty.show('Продолжить: ' + label + ' (' + formatSeconds(resume.time) + ')');
        advanceOrchestrator();
    }

    function isOnlineEpisodeListContainer(root) {
        if (!root) {
            return false;
        }
        const hasFilterBar = Boolean(root.querySelector('.filter, .simple-button--filter, .filter--sort, .filter--filter'));
        const hasOnlineItems = Boolean(root.querySelector('.online-prestige, .online, .online-prestige-s'));
        return hasFilterBar && hasOnlineItems;
    }

    function createTextElement(tag, className, text) {
        const node = document.createElement(tag);
        if (className) {
            node.className = className;
        }
        if (text !== undefined && text !== null) {
            node.textContent = String(text);
        }
        return node;
    }

    function buildResumeBarElement(resume) {
        const bar = document.createElement('div');
        bar.className = CSS_CLASSES.BAR + ' selector';
        bar.setAttribute('data-gh-sig', [
            resume.movieKey,
            resume.season,
            resume.episode,
            resume.time,
            resume.voice,
            resume.source,
            resume.quality,
            resume.updatedAt
        ].join('|'));

        const mainRow = createTextElement('div', CSS_CLASSES.BAR_MAIN, '');
        const iconNode = createTextElement('div', CSS_CLASSES.BAR_ICON, '▶');
        const infoNode = createTextElement('div', CSS_CLASSES.BAR_INFO, '');

        const headingText = resume.mediaType === 'tv' && resume.episode > 0
            ? 'Продолжить: Сезон ' + (resume.season || 1) + ' • Серия ' + resume.episode
            : 'Продолжить просмотр';
        const titleNode = createTextElement('div', CSS_CLASSES.BAR_TITLE, headingText);

        const metaRow = createTextElement('div', CSS_CLASSES.BAR_META, '');
        if (resume.voice) {
            metaRow.appendChild(createTextElement('span', CSS_CLASSES.BAR_TAG, resume.voice));
        }
        if (resume.source) {
            metaRow.appendChild(createTextElement('span', CSS_CLASSES.BAR_TAG, resume.source));
        }
        if (resume.quality) {
            metaRow.appendChild(createTextElement('span', CSS_CLASSES.BAR_TAG, resume.quality));
        }

        infoNode.appendChild(titleNode);
        if (metaRow.childNodes.length > 0) {
            infoNode.appendChild(metaRow);
        }

        const timeLabel = resume.duration > 0
            ? formatSeconds(resume.time) + ' / ' + formatSeconds(resume.duration)
            : formatSeconds(resume.time);
        const timeNode = createTextElement('div', CSS_CLASSES.BAR_TIME, timeLabel);

        mainRow.appendChild(iconNode);
        mainRow.appendChild(infoNode);
        mainRow.appendChild(timeNode);
        bar.appendChild(mainRow);

        if (resume.percent > 0) {
            const progressTrack = createTextElement('div', CSS_CLASSES.BAR_PROGRESS, '');
            const progressFill = createTextElement('div', CSS_CLASSES.BAR_PROGRESS_FILL, '');
            progressFill.style.width = Math.min(100, Math.max(0, resume.percent)) + '%';
            progressTrack.appendChild(progressFill);
            bar.appendChild(progressTrack);
        }

        if (window.$) {
            window.$(bar).on('hover:enter', function () {
                startResumeOrchestration(resume);
            });
            window.$(bar).on('hover:focus', function () {
                bar.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            });
        } else {
            bar.addEventListener('click', function () {
                startResumeOrchestration(resume);
            });
        }

        return bar;
    }

    function refreshCurrentResumeBar() {
        const descriptor = getActiveMovieDescriptor();
        const root = getActiveRenderRoot();
        if (!descriptor || !root || !isOnlineEpisodeListContainer(root)) {
            return;
        }

        const scrollBody = root.querySelector('.scroll__body');
        if (!scrollBody) {
            return;
        }

        const resumes = getSafeObjectStorage(STORAGE_KEYS.RESUMES);
        const saved = normalizeResumeEntry(descriptor.movieKey, resumes[descriptor.movieKey]);
        const existingBar = scrollBody.querySelector('.' + CSS_CLASSES.BAR);

        if (!saved || (saved.time < CONFIG.MIN_RESUME_SECONDS && saved.episode === 0)) {
            if (existingBar) {
                existingBar.remove();
            }
            return;
        }

        const nextBar = buildResumeBarElement(saved);
        if (existingBar && existingBar.getAttribute('data-gh-sig') === nextBar.getAttribute('data-gh-sig')) {
            return;
        }

        if (existingBar) {
            existingBar.replaceWith(nextBar);
            return;
        }

        scrollBody.insertBefore(nextBar, scrollBody.firstChild);
    }

    function detachActiveObserver() {
        if (runtime.activeObserver) {
            runtime.activeObserver.disconnect();
            runtime.activeObserver = null;
        }
        if (runtime.mutationDebounceTimer) {
            clearTimeout(runtime.mutationDebounceTimer);
            runtime.mutationDebounceTimer = null;
        }
    }

    function attachObserverToActiveView() {
        detachActiveObserver();
        const root = getActiveRenderRoot();
        if (!root || typeof MutationObserver === 'undefined') {
            return;
        }

        runtime.activeObserver = new MutationObserver(function (mutations) {
            let hasExternalChange = false;
            for (let i = 0; i < mutations.length; i++) {
                const target = mutations[i].target;
                if (target && target.nodeType === 1 && target.closest('.' + CSS_CLASSES.BAR)) {
                    continue;
                }
                hasExternalChange = true;
                break;
            }
            if (!hasExternalChange) {
                return;
            }

            if (runtime.mutationDebounceTimer) {
                clearTimeout(runtime.mutationDebounceTimer);
            }
            runtime.mutationDebounceTimer = setTimeout(function () {
                runtime.mutationDebounceTimer = null;
                refreshCurrentResumeBar();
                if (runtime.orchestrator.active) {
                    advanceOrchestrator();
                }
            }, CONFIG.MUTATION_DEBOUNCE_MS);
        });

        runtime.activeObserver.observe(root, {
            childList: true,
            subtree: true
        });

        refreshCurrentResumeBar();
    }

    function injectStyles() {
        if (document.getElementById(CSS_CLASSES.STYLE_ID)) {
            return;
        }
        const style = document.createElement('style');
        style.id = CSS_CLASSES.STYLE_ID;
        style.textContent = [
            '.gh-resume-bar {',
            '  position: relative;',
            '  margin: 0.35em 0 0.85em 0;',
            '  padding: 0.75em 1em 0.9em 1em;',
            '  border-radius: 0.7em;',
            '  background: rgba(255, 255, 255, 0.09);',
            '  border: 2px solid rgba(255, 255, 255, 0.14);',
            '  cursor: pointer;',
            '  overflow: hidden;',
            '  transition: background-color 0.18s ease, border-color 0.18s ease, transform 0.18s ease;',
            '  box-sizing: border-box;',
            '  width: 100%;',
            '}',
            '.gh-resume-bar.focus, .gh-resume-bar:hover {',
            '  background: rgba(255, 255, 255, 0.2);',
            '  border-color: #ffffff;',
            '}',
            '.gh-resume-bar__main {',
            '  display: flex;',
            '  align-items: center;',
            '  justify-content: space-between;',
            '  gap: 0.75em;',
            '  flex-wrap: wrap;',
            '}',
            '.gh-resume-bar__icon {',
            '  flex: 0 0 auto;',
            '  width: 2.1em;',
            '  height: 2.1em;',
            '  border-radius: 50%;',
            '  background: rgba(255, 255, 255, 0.18);',
            '  display: flex;',
            '  align-items: center;',
            '  justify-content: center;',
            '  font-size: 0.95em;',
            '  color: #ffffff;',
            '}',
            '.gh-resume-bar__info {',
            '  flex: 1 1 12em;',
            '  min-width: 0;',
            '  display: flex;',
            '  flex-direction: column;',
            '  gap: 0.3em;',
            '}',
            '.gh-resume-bar__title {',
            '  font-size: 1.05em;',
            '  font-weight: 600;',
            '  color: #ffffff;',
            '  line-height: 1.25;',
            '  word-break: break-word;',
            '}',
            '.gh-resume-bar__meta {',
            '  display: flex;',
            '  flex-wrap: wrap;',
            '  gap: 0.4em;',
            '}',
            '.gh-resume-bar__tag {',
            '  font-size: 0.8em;',
            '  padding: 0.15em 0.55em;',
            '  border-radius: 0.35em;',
            '  background: rgba(255, 255, 255, 0.12);',
            '  color: rgba(255, 255, 255, 0.88);',
            '  max-width: 100%;',
            '  overflow: hidden;',
            '  text-overflow: ellipsis;',
            '  white-space: nowrap;',
            '}',
            '.gh-resume-bar__time {',
            '  flex: 0 0 auto;',
            '  font-size: 0.95em;',
            '  font-weight: 600;',
            '  padding: 0.3em 0.65em;',
            '  border-radius: 0.4em;',
            '  background: rgba(0, 0, 0, 0.35);',
            '  color: #ffffff;',
            '  white-space: nowrap;',
            '}',
            '.gh-resume-bar__progress {',
            '  position: absolute;',
            '  left: 0;',
            '  right: 0;',
            '  bottom: 0;',
            '  height: 0.22em;',
            '  background: rgba(255, 255, 255, 0.15);',
            '}',
            '.gh-resume-bar__progress-fill {',
            '  height: 100%;',
            '  background: #ffffff;',
            '}',
            '@media screen and (max-width: 600px) {',
            '  .gh-resume-bar { padding: 0.65em 0.75em 0.8em 0.75em; }',
            '  .gh-resume-bar__time { width: 100%; text-align: left; background: transparent; padding: 0; font-size: 0.88em; opacity: 0.9; }',
            '}'
        ].join('\n');
        document.head.appendChild(style);
    }

    function openSettingInputDialog(title, storageKey, defaultValue, onSaved) {
        const currentValue = String(Lampa.Storage.get(storageKey, defaultValue || ''));
        Lampa.Input.edit({
            title: title,
            value: currentValue,
            free: true,
            nosave: true
        }, function (newValue) {
            const cleaned = String(newValue || '').trim();
            Lampa.Storage.set(storageKey, cleaned || defaultValue || '');
            if (typeof onSaved === 'function') {
                onSaved(cleaned);
            }
            if (Lampa.Settings && typeof Lampa.Settings.update === 'function') {
                Lampa.Settings.update();
            }
        });
    }

    function registerSettingsUi() {
        if (!Lampa.SettingsApi) {
            return;
        }

        const iconSvg = '<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M12 2C6.48 2 2 6.58 2 12.26c0 4.54 2.87 8.39 6.84 9.75.5.09.68-.22.68-.49 0-.24-.01-.88-.01-1.73-2.78.62-3.37-1.37-3.37-1.37-.45-1.18-1.11-1.5-1.11-1.5-.91-.64.07-.63.07-.63 1 .07 1.53 1.06 1.53 1.06.89 1.56 2.34 1.11 2.91.85.09-.66.35-1.11.63-1.37-2.22-.26-4.56-1.14-4.56-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.31.1-2.73 0 0 .84-.28 2.75 1.05A9.35 9.35 0 0 1 12 6.84c.85 0 1.71.12 2.51.35 1.91-1.33 2.75-1.05 2.75-1.05.55 1.42.2 2.47.1 2.73.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.81-4.57 5.06.36.32.68.94.68 1.9 0 1.37-.01 2.48-.01 2.82 0 .27.18.59.69.49A10.27 10.27 0 0 0 22 12.26C22 6.58 17.52 2 12 2Z"/></svg>';

        Lampa.SettingsApi.addComponent({
            component: CONFIG.COMPONENT_ID,
            name: 'GitHub Sync',
            icon: iconSvg
        });

        Lampa.SettingsApi.addParam({
            component: CONFIG.COMPONENT_ID,
            param: { name: 'gh_sync_btn_token', type: 'button' },
            field: { name: 'GitHub Token (PAT)', description: 'Нажмите, чтобы задать токен' },
            onRender: function (item) {
                item.find('.settings-param__descr').text('Текущий: ' + maskSecret(Lampa.Storage.get(STORAGE_KEYS.TOKEN, '')));
            },
            onChange: function () {
                openSettingInputDialog('GitHub Personal Access Token', STORAGE_KEYS.TOKEN, '');
            }
        });

        Lampa.SettingsApi.addParam({
            component: CONFIG.COMPONENT_ID,
            param: { name: 'gh_sync_btn_repo', type: 'button' },
            field: { name: 'Репозиторий (owner/repo)', description: 'Например: username/lampa-sync' },
            onRender: function (item) {
                const value = String(Lampa.Storage.get(STORAGE_KEYS.REPO, '')).trim();
                item.find('.settings-param__descr').text(value || 'Не задан (формат: owner/repo)');
            },
            onChange: function () {
                openSettingInputDialog('Репозиторий (owner/repo)', STORAGE_KEYS.REPO, '');
            }
        });

        Lampa.SettingsApi.addParam({
            component: CONFIG.COMPONENT_ID,
            param: { name: 'gh_sync_btn_branch', type: 'button' },
            field: { name: 'Ветка', description: CONFIG.DEFAULT_BRANCH },
            onRender: function (item) {
                const value = String(Lampa.Storage.get(STORAGE_KEYS.BRANCH, CONFIG.DEFAULT_BRANCH)).trim();
                item.find('.settings-param__descr').text(value || CONFIG.DEFAULT_BRANCH);
            },
            onChange: function () {
                openSettingInputDialog('Ветка репозитория', STORAGE_KEYS.BRANCH, CONFIG.DEFAULT_BRANCH);
            }
        });

        Lampa.SettingsApi.addParam({
            component: CONFIG.COMPONENT_ID,
            param: { name: 'gh_sync_btn_path', type: 'button' },
            field: { name: 'Файл синхронизации', description: CONFIG.DEFAULT_FILE_PATH },
            onRender: function (item) {
                const value = String(Lampa.Storage.get(STORAGE_KEYS.PATH, CONFIG.DEFAULT_FILE_PATH)).trim();
                item.find('.settings-param__descr').text(value || CONFIG.DEFAULT_FILE_PATH);
            },
            onChange: function () {
                openSettingInputDialog('Путь к JSON файлу', STORAGE_KEYS.PATH, CONFIG.DEFAULT_FILE_PATH);
            }
        });

        Lampa.SettingsApi.addParam({
            component: CONFIG.COMPONENT_ID,
            param: { name: STORAGE_KEYS.AUTO_SYNC, type: 'trigger', default: true },
            field: { name: 'Автосинхронизация', description: 'Синхронизировать при запуске и остановке видео' }
        });

        Lampa.SettingsApi.addParam({
            component: CONFIG.COMPONENT_ID,
            param: { name: 'gh_sync_btn_now', type: 'button' },
            field: { name: 'Синхронизировать сейчас', description: 'Объединить локальные и облачные таймкоды' },
            onChange: function () {
                executeSync({ notify: true });
            }
        });

        Lampa.SettingsApi.addParam({
            component: CONFIG.COMPONENT_ID,
            param: { name: 'gh_sync_btn_test', type: 'button' },
            field: { name: 'Проверить подключение', description: 'Проверить доступ токена к репозиторию' },
            onChange: function () {
                testGitHubConnection();
            }
        });
    }

    function bindLifecycleListeners() {
        if (Lampa.Timeline && Lampa.Timeline.listener) {
            Lampa.Timeline.listener.follow('update', function (event) {
                if (event && event.data) {
                    handleTimelineRecordUpdate(event.data);
                }
            });
        }

        if (Lampa.Player && Lampa.Player.listener) {
            Lampa.Player.listener.follow('destroy', function () {
                if (isAutoSyncEnabled() && getSyncCredentials().isValid) {
                    executeSync({ notify: false });
                }
                setTimeout(refreshCurrentResumeBar, 350);
            });
        }

        if (Lampa.Storage && Lampa.Storage.listener) {
            Lampa.Storage.listener.follow('change', function (event) {
                if (runtime.isApplyingRemote || !event || event.name !== STORAGE_KEYS.FILE_VIEW) {
                    return;
                }
                scheduleDebouncedSync();
            });
        }

        if (Lampa.Listener) {
            Lampa.Listener.follow('activity', function (event) {
                if (!event || (event.type !== 'start' && event.type !== 'resume' && event.type !== 'toggle')) {
                    return;
                }
                stopOrchestrator();
                setTimeout(attachObserverToActiveView, 150);
            });
        }
    }

    function initializePlugin() {
        injectStyles();
        registerSettingsUi();
        installPlayerPlayInterceptor();
        installSelectInterceptor();
        bindLifecycleListeners();
        attachObserverToActiveView();

        if (isAutoSyncEnabled() && getSyncCredentials().isValid) {
            executeSync({ notify: false });
        }
    }

    if (window.appready) {
        initializePlugin();
    } else if (window.Lampa && Lampa.Listener) {
        Lampa.Listener.follow('app', function (event) {
            if (event && event.type === 'ready') {
                initializePlugin();
            }
        });
    }
})();
