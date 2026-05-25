(function() {
    let exportAction;
    let settingsAction;

    Plugin.register('batch_group_exporter', {
        title: 'Batch Group Exporter',
        author: 'Gemini',
        description: 'Exports all visible groups individually as OBJ or FBX files. Settings are persistently saved per-project.',
        icon: 'archive',
        version: '1.6.0', // Added FBX export option
        variant: 'desktop', 
        
        onload() {
            // Standard Export Action
            exportAction = new Action('export_visible_groups', {
                name: 'Export Visible Groups (Batch)',
                description: 'Exports all visible folders individually with their direct meshes using configured settings.',
                icon: 'drive_folder_upload',
                click: function() {
                    runExport(); 
                }
            });

            // Action to open settings window
            settingsAction = new Action('batch_export_settings', {
                name: 'Batch Export Settings...',
                description: 'Configure format, scale, output folder, prefix, position, and rotations for the Batch Group Exporter.',
                icon: 'settings',
                click: function() {
                    openSettings();
                }
            });

            MenuBar.addAction(exportAction, 'file.export');
            MenuBar.addAction(settingsAction, 'file.export');
            console.log("[BatchGroupExporter] Plugin loaded successfully.");
        },
        
        onunload() {
            exportAction.delete();
            settingsAction.delete();
            console.log("[BatchGroupExporter] Plugin unloaded.");
        }
    });

    // --- CONFIGURATION MANAGER ---
    // Uses LocalStorage to persist settings safely across app restarts and project reloads
    const PROJECT_CONFIG_PREFIX = 'batch_exporter_cfg_';
    const LAST_CONFIG_KEY = 'batch_exporter_cfg_last';

    function getDefaultConfig() {
        return { dir: '', scale: 1, rotationMode: 'keep_all', positionMode: 'keep_original', format: 'obj', prefix: '' };
    }

    function normalizeConfig(config) {
        let normalized = Object.assign({}, getDefaultConfig(), config || {});
        let scale = parseFloat(normalized.scale);
        normalized.scale = Number.isFinite(scale) && scale > 0 ? scale : 1;

        if (normalized.positionMode === 'center_origin') normalized.positionMode = 'group_pivot';
        if (normalized.resetRotation !== undefined) {
            normalized.rotationMode = normalized.resetRotation ? 'reset_group' : 'keep_all';
            delete normalized.resetRotation;
        }
        if (normalized.format !== 'fbx') normalized.format = 'obj';

        return normalized;
    }

    function getProjectConfigKey() {
        if (!Project || !Project.uuid) return null;
        return PROJECT_CONFIG_PREFIX + Project.uuid;
    }

    function getConfig() {
        if (!Project) return null;
        let storageKey = getProjectConfigKey();
        
        // 1. Return current session config if it already exists
        if (Project.batch_export_config && Project.batch_export_config_key === storageKey) {
            return normalizeConfig(Project.batch_export_config);
        }
        
        try {
            // 2. Try to load this specific project's saved config from the local database
            if (storageKey) {
                let stored = localStorage.getItem(storageKey);
                if (stored) {
                    let parsed = normalizeConfig(JSON.parse(stored));
                    Project.batch_export_config = parsed;
                    Project.batch_export_config_key = storageKey;
                    return normalizeConfig(parsed);
                }
            }

            if (Project.batch_export_config && (!Project.batch_export_config_key || !storageKey)) {
                let parsed = normalizeConfig(Project.batch_export_config);
                Project.batch_export_config = parsed;
                Project.batch_export_config_key = storageKey;
                return normalizeConfig(parsed);
            }
            
            // 3. Fallback: If this is a brand new project, use the last saved settings from OTHER projects,
            // but clear the directory so we don't accidentally overwrite files in another project's folder.
            let globalStored = localStorage.getItem(LAST_CONFIG_KEY);
            if (globalStored) {
                let parsedGlobal = normalizeConfig(JSON.parse(globalStored));
                parsedGlobal.dir = ''; // Clear directory for safety
                Project.batch_export_config = parsedGlobal;
                Project.batch_export_config_key = storageKey;
                return normalizeConfig(parsedGlobal);
            }
        } catch(e) {
            console.warn("[BatchGroupExporter] Failed to load config from storage:", e);
        }

        // 4. Ultimate fallback to default
        let defaultConfig = getDefaultConfig();
        Project.batch_export_config = defaultConfig;
        Project.batch_export_config_key = storageKey;
        return normalizeConfig(defaultConfig);
    }

    function saveConfig(config) {
        if (!Project) return;

        let normalized = normalizeConfig(config);
        let storageKey = getProjectConfigKey();

        Project.batch_export_config = normalized;
        Project.batch_export_config_key = storageKey;
        
        try {
            // Save specifically for this project
            if (storageKey) {
                localStorage.setItem(storageKey, JSON.stringify(normalized));
            }

            // Save as global default for future new projects
            localStorage.setItem(LAST_CONFIG_KEY, JSON.stringify(Object.assign({}, normalized, { dir: '' })));
        } catch(e) {
            console.warn("[BatchGroupExporter] Failed to save config to storage:", e);
        }
    }

    function getExportScene() {
        if (typeof scene !== 'undefined') return scene;
        if (typeof Canvas !== 'undefined' && Canvas.scene) return Canvas.scene;
        return null;
    }

    function getModelExportScale() {
        try {
            if (typeof Settings !== 'undefined' && Settings.get) {
                let modelScale = parseFloat(Settings.get('model_export_scale'));
                if (Number.isFinite(modelScale) && modelScale > 0) return modelScale;
            }
        } catch (e) {}

        return 16;
    }

    function getFbxCompileOptions(scaleMultiplier) {
        return {
            encoding: 'ascii',
            include_animations: false,
            embed_textures: false,
            scale: getModelExportScale() / scaleMultiplier
        };
    }

    function findMatchingBrace(text, openBraceIndex) {
        let depth = 0;
        for (let i = openBraceIndex; i < text.length; i++) {
            if (text[i] === '{') {
                depth++;
            } else if (text[i] === '}') {
                depth--;
                if (depth === 0) return i;
            }
        }
        return -1;
    }

    function countFbxPolygons(geometryBlock) {
        let match = geometryBlock.match(/PolygonVertexIndex:\s*\*\d+\s*\{[\s\S]*?\ba:\s*([^\r\n}]*)/);
        if (!match) return 0;

        return match[1]
            .split(',')
            .map(value => parseInt(value.trim(), 10))
            .filter(value => Number.isFinite(value) && value < 0)
            .length;
    }

    function insertFbxSmoothingLayerElement(geometryBlock, indent) {
        let layerMatch = geometryBlock.match(/\n(\s*)Layer:\s*0\s*\{/);
        if (!layerMatch) return geometryBlock;

        let layerOpen = layerMatch.index + layerMatch[0].lastIndexOf('{');
        let layerClose = findMatchingBrace(geometryBlock, layerOpen);
        if (layerClose === -1) return geometryBlock;

        let layerBlock = geometryBlock.slice(layerMatch.index, layerClose + 1);
        let maxLayerElement = 0;
        layerBlock.replace(/LayerElement(\d+):/g, function(match, index) {
            maxLayerElement = Math.max(maxLayerElement, parseInt(index, 10));
            return match;
        });

        let childIndent = layerMatch[1] + '\t';
        let smoothingLayerElement = [
            `${childIndent}LayerElement${maxLayerElement + 1}: {`,
            `${childIndent}\tType: "LayerElementSmoothing"`,
            `${childIndent}\tTypedIndex: 0`,
            `${childIndent}}`
        ].join('\n');

        return geometryBlock.slice(0, layerClose)
            + '\n' + smoothingLayerElement
            + geometryBlock.slice(layerClose);
    }

    function addFbxSmoothingGroups(content) {
        if (typeof content !== 'string' || content.includes('LayerElementSmoothing')) return content;

        let output = '';
        let cursor = 0;
        let geometryPattern = /\n?(\s*)Geometry:\s*[^{}]*\{/g;
        let match;

        while ((match = geometryPattern.exec(content)) !== null) {
            let blockStart = match.index + (match[0][0] === '\n' ? 1 : 0);
            let openBrace = geometryPattern.lastIndex - 1;
            let blockEnd = findMatchingBrace(content, openBrace);
            if (blockEnd === -1) break;

            let block = content.slice(blockStart, blockEnd + 1);
            let polygonCount = countFbxPolygons(block);
            if (polygonCount > 0 && !block.includes('LayerElementSmoothing')) {
                let indent = match[1];
                let childIndent = indent + '\t';
                let isSmoothNormalLayer = /LayerElementNormal:[\s\S]*?MappingInformationType:\s*"ByVertex"/.test(block);
                let smoothingValue = isSmoothNormalLayer ? 1 : 0;
                let smoothingValues = Array(polygonCount).fill(smoothingValue).join(',');
                let smoothingBlock = [
                    `${childIndent}LayerElementSmoothing: 0 {`,
                    `${childIndent}\tVersion: 102`,
                    `${childIndent}\tName: ""`,
                    `${childIndent}\tMappingInformationType: "ByPolygon"`,
                    `${childIndent}\tReferenceInformationType: "Direct"`,
                    `${childIndent}\tSmoothing: *${polygonCount} {`,
                    `${childIndent}\t\ta: ${smoothingValues}`,
                    `${childIndent}\t}`,
                    `${childIndent}}`
                ].join('\n');

                let layerIndex = block.search(/\n\s*Layer:\s*0\s*\{/);
                if (layerIndex !== -1) {
                    block = block.slice(0, layerIndex)
                        + '\n' + smoothingBlock
                        + block.slice(layerIndex);
                    block = insertFbxSmoothingLayerElement(block, indent);
                }
            }

            output += content.slice(cursor, blockStart) + block;
            cursor = blockEnd + 1;
            geometryPattern.lastIndex = cursor;
        }

        return output + content.slice(cursor);
    }
    // -----------------------------

    // Function to physically scale the vertices inside the raw OBJ string
    function applyScaleToOBJ(objString, scale) {
        if (scale === 1 || !objString) return objString;
        let lines = objString.split('\n');
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith('v ')) {
                let parts = lines[i].trim().split(/\s+/); 
                if (parts.length >= 4) {
                    let x = (parseFloat(parts[1]) * scale).toFixed(6);
                    let y = (parseFloat(parts[2]) * scale).toFixed(6);
                    let z = (parseFloat(parts[3]) * scale).toFixed(6);
                    
                    if (!isNaN(x) && !isNaN(y) && !isNaN(z)) {
                        lines[i] = `v ${x} ${y} ${z}`;
                    }
                }
            }
        }
        return lines.join('\n');
    }

    function openSettings() {
        if (!Project) {
            Blockbench.showMessageBox({title: 'No Project', message: 'Please open a project first to configure settings.'});
            return;
        }
        
        let cfg = getConfig();
        
        let settingsDialog = new Dialog({
            id: 'batch_exporter_settings',
            title: 'Batch Exporter Settings',
            form: {
                scale: {
                    label: 'Export Scale Multiplier',
                    type: 'number',
                    value: cfg.scale,
                    min: 0.001,
                    step: 0.1,
                    description: 'Changes the physical size of the exported meshes.'
                },
                positionMode: {
                    label: 'Position Handling',
                    type: 'select',
                    options: {
                        'keep_original': 'Keep Original Position (World coordinates)',
                        'group_pivot': 'Use Group Pivot as Origin (Moves group pivot to 0,0,0)'
                    },
                    value: cfg.positionMode,
                    description: 'Should the exported meshes stay in their exact world location or center relative to their group pivot point?'
                },
                rotationMode: {
                    label: 'Rotation Handling',
                    type: 'select',
                    options: {
                        'keep_all': 'Keep All Rotations (Baked into mesh)',
                        'reset_group': 'Reset Group Rotation (Keep element rotations)',
                        'reset_all': 'Reset All Rotations (Unrotated raw meshes)'
                    },
                    value: cfg.rotationMode,
                    description: 'How to handle rotations. "Keep All" maintains Blockbench orientation.'
                },
                exportFormat: {
                    label: 'Export Format',
                    type: 'select',
                    options: {
                        'obj': 'OBJ (.obj + .mtl)',
                        'fbx': 'FBX ASCII (.fbx)'
                    },
                    value: cfg.format,
                    description: 'FBX ASCII is recommended for Unreal Engine static mesh import.'
                },
                prefix: {
                    label: 'Export Filename Prefix',
                    type: 'text',
                    value: cfg.prefix || '',
                    placeholder: 'e.g., prop_ or obj_',
                    description: 'Optional text added to the beginning of every exported file name.'
                },
                outDir: {
                    label: 'Export Directory',
                    type: 'text',
                    value: cfg.dir,
                    placeholder: 'Leave blank to be prompted during export...',
                    description: 'The target folder for the exported group files.'
                }
            },
            onConfirm: function(formData) {
                let newCfg = {
                    scale: parseFloat(formData.scale) || 1,
                    positionMode: formData.positionMode,
                    rotationMode: formData.rotationMode,
                    format: formData.exportFormat,
                    prefix: formData.prefix || '',
                    dir: formData.outDir
                };
                saveConfig(newCfg);
                this.hide();
                Blockbench.showQuickMessage('Batch Exporter settings saved.');
            }
        });
        
        settingsDialog.show();
    }

    function runExport() {
        console.log("[BatchGroupExporter] --- Starting batch export process ---");

        if (typeof isApp === 'undefined' || !isApp) {
            console.error("[BatchGroupExporter] Failed: Not running on Desktop version.");
            Blockbench.showMessageBox({
                title: 'Environment Error',
                message: 'Batch exporting multiple files requires the Blockbench Desktop App to save directly to a local folder.'
            });
            return;
        }

        const fs = require('fs');
        const path = require('path');
        
        if (!Project) return;

        let cfg = getConfig();
        let savedDir = cfg.dir;
        let currentScale = cfg.scale;
        let currentPosMode = cfg.positionMode;
        let currentRotMode = cfg.rotationMode;
        let currentFormat = cfg.format;
        let currentPrefix = cfg.prefix || '';
        let needsPrompt = !savedDir || !fs.existsSync(savedDir);

        function isElementVisible(el) {
            if (el.visibility === false) return false;
            let parent = el.parent;
            while (parent && parent !== 'root') {
                if (parent.visibility === false) return false;
                parent = parent.parent;
            }
            return true;
        }

        let groupsToExport = [];
        Group.all.forEach(group => {
            if (!isElementVisible(group)) return;

            let directValidChildren = group.children.filter(child => {
                let isFolder = child instanceof Group;
                let isVisible = child.visibility !== false;
                return !isFolder && isVisible;
            });

            if (directValidChildren.length > 0) {
                groupsToExport.push({ group: group, children: directValidChildren });
            }
        });

        if (groupsToExport.length === 0) {
            console.warn("[BatchGroupExporter] No valid groups found to export.");
            Blockbench.showMessageBox({
                title: 'No Groups Found',
                message: 'No visible groups with direct mesh children were found to export.'
            });
            return;
        }

        function executeBatch(outDir) {
            console.log(`[BatchGroupExporter] Starting batch processing in directory: ${outDir}`);
            console.log(`[BatchGroupExporter] Using export scale multiplier: ${currentScale}`);
            console.log(`[BatchGroupExporter] Rotation handling mode: ${currentRotMode}`);
            console.log(`[BatchGroupExporter] Position handling mode: ${currentPosMode}`);
            console.log(`[BatchGroupExporter] Export format: ${currentFormat}`);
            console.log(`[BatchGroupExporter] Using prefix: '${currentPrefix}'`);
            const exportScene = getExportScene();
            const codec = Codecs[currentFormat];
            const extension = currentFormat === 'fbx' ? 'fbx' : 'obj';
            
            // Safely collect all Outliner elements to avoid relying on visual hierarchy arrays
            let allNodes = [];
            if (typeof Group !== 'undefined' && Group.all) allNodes.push(...Group.all);
            if (typeof Project !== 'undefined' && Project.elements) allNodes.push(...Project.elements);
            else {
                if (typeof Cube !== 'undefined' && Cube.all) allNodes.push(...Cube.all);
                if (typeof Mesh !== 'undefined' && Mesh.all) allNodes.push(...Mesh.all);
            }

            // Global visibility and export cache
            let stateCache = new Map();
            allNodes.forEach(n => stateCache.set(n.uuid, { vis: n.visibility, exp: n.export }));

            let exportedCount = 0;
            let errors = 0;

            if (!codec) {
                let formatName = currentFormat.toUpperCase();
                console.error(`[BatchGroupExporter] ${formatName} Codec not found for this project type.`);
                Blockbench.showMessageBox({ title: 'Format Error', message: `${formatName} exporting is not available in this workspace format.`});
                return;
            }

            groupsToExport.forEach(item => {
                let group = item.group;
                let children = item.children;
                
                try {
                    // Hide AND disable export for EVERYTHING globally
                    allNodes.forEach(n => { n.visibility = false; n.export = false; });

                    // Reveal and enable export ONLY for this group's hierarchy and direct children
                    group.visibility = true;
                    group.export = true;
                    let p = group.parent;
                    while (p && p !== 'root') {
                        p.visibility = true;
                        p.export = true;
                        p = p.parent;
                    }
                    children.forEach(child => {
                        child.visibility = true;
                        child.export = true;
                    });

                    // Initial geometry update to ensure the matrices reflect current BB visual state
                    Canvas.updateVisibility();
                    if (exportScene) exportScene.updateMatrixWorld(true);

                    // DIRECT THREE.JS MANIPULATION CACHE
                    let threeCache = new Map();
                    function cacheThree(n) {
                        if (n.mesh) {
                            threeCache.set(n.uuid, {
                                pos: n.mesh.position.clone(),
                                rot: n.mesh.rotation.clone(),
                                quat: n.mesh.quaternion.clone(),
                                parent: n.mesh.parent
                            });
                        }
                        if (n.children) n.children.forEach(cacheThree);
                    }
                    cacheThree(group);

                    // ISOLATE AND MODIFY THREE.JS MATRICES
                    if (group.mesh && typeof THREE !== 'undefined' && exportScene) {
                        // Ensure world matrices are up to date before grabbing coordinates
                        group.mesh.updateMatrixWorld(true);
                        let worldPos = new THREE.Vector3();
                        let worldQuat = new THREE.Quaternion();
                        group.mesh.getWorldPosition(worldPos);
                        group.mesh.getWorldQuaternion(worldQuat);

                        // Temporarily isolate group to the root of the Scene to decouple it from parent transforms
                        exportScene.add(group.mesh);

                        // POSITION OVERRIDE
                        if (currentPosMode === 'group_pivot') {
                            // Being parented directly to the scene means 0,0,0 sets the pivot directly to the world origin
                            group.mesh.position.set(0, 0, 0);
                        } else {
                            group.mesh.position.copy(worldPos);
                        }

                        // ROTATION OVERRIDES
                        if (currentRotMode === 'reset_group' || currentRotMode === 'reset_all') {
                            group.mesh.quaternion.set(0, 0, 0, 1);
                        } else {
                            group.mesh.quaternion.copy(worldQuat);
                        }
                    }

                    if (currentRotMode === 'reset_all') {
                        function resetChildRots(n) {
                            if (n !== group && n.mesh) {
                                n.mesh.rotation.set(0, 0, 0);
                                n.mesh.quaternion.set(0, 0, 0, 1);
                            }
                            if (n.children) n.children.forEach(resetChildRots);
                        }
                        resetChildRots(group);
                    }

                    // Force the Three.js scene graph to process the new math so the compiler sees it
                    if (group.mesh) group.mesh.updateMatrixWorld(true);

                    console.log(`[BatchGroupExporter] Compiling ${currentFormat.toUpperCase()} for group '${group.name}'...`);
                    let content = currentFormat === 'fbx'
                        ? codec.compile(getFbxCompileOptions(currentScale))
                        : codec.compile({ all_files: true });

                    // RESTORE THREE.JS CACHE IMMEDIATELY
                    function restoreThree(n) {
                        if (n.mesh && threeCache.has(n.uuid)) {
                            let state = threeCache.get(n.uuid);
                            if (state.parent) state.parent.add(n.mesh);
                            n.mesh.position.copy(state.pos);
                            n.mesh.rotation.copy(state.rot);
                            n.mesh.quaternion.copy(state.quat);
                            n.mesh.updateMatrixWorld(true);
                        }
                        if (n.children) n.children.forEach(restoreThree);
                    }
                    restoreThree(group);

                    let outputData = typeof content === 'string' || content instanceof Uint8Array
                        ? content
                        : (content && content.obj ? content.obj : null);
                    if (!outputData) throw new Error("Codec returned empty or invalid data.");

                    if (currentFormat === 'obj') {
                        outputData = applyScaleToOBJ(outputData, currentScale);
                    } else if (currentFormat === 'fbx') {
                        outputData = addFbxSmoothingGroups(outputData);
                    }

                    // Prepend the prefix and sanitize the final filename
                    let rawName = currentPrefix + group.name;
                    let safeName = rawName.replace(/[^a-zA-Z0-9_\-\ ]/gi, '_');
                    if (!safeName || safeName.trim() === "") safeName = 'group_' + group.uuid.substring(0, 5);
                    
                    let filePath = path.join(outDir, `${safeName}.${extension}`);

                    fs.writeFileSync(filePath, outputData);
                    if (currentFormat === 'obj' && content && typeof content === 'object' && content.mtl) {
                        fs.writeFileSync(filePath.replace('.obj', '.mtl'), content.mtl);
                    }

                    console.log(`[BatchGroupExporter] Successfully saved: ${filePath}`);
                    exportedCount++;

                } catch (err) {
                    console.error(`[BatchGroupExporter] Error exporting group '${group.name}':`, err);
                    errors++;
                }
            });

            // Restore global Blockbench visibilities and export states
            console.log("[BatchGroupExporter] Restoring workspace visibility and export states...");
            allNodes.forEach(n => {
                if (stateCache.has(n.uuid)) {
                    let state = stateCache.get(n.uuid);
                    n.visibility = state.vis;
                    n.export = state.exp;
                }
            });
            
            Canvas.updateVisibility();
            if (exportScene) exportScene.updateMatrixWorld(true);

            console.log(`[BatchGroupExporter] --- Process complete. Exported: ${exportedCount}, Errors: ${errors} ---`);
            Blockbench.showMessageBox({
                title: 'Batch Export Complete',
                message: `Successfully exported ${exportedCount} groups to:\n${outDir}\n\nFormat: ${currentFormat.toUpperCase()}\nScale applied: x${currentScale}\nErrors encountered: ${errors}\n\n(Press Ctrl+Shift+I and check the console for logs)`
            });
        }

        if (!needsPrompt) {
            console.log("[BatchGroupExporter] Using saved directory:", savedDir);
            executeBatch(savedDir);
            return;
        }

        try {
            const remote = require('@electron/remote');
            let dirPaths = remote.dialog.showOpenDialogSync({
                title: 'Select Output Directory for Group Exports',
                properties: ['openDirectory', 'createDirectory']
            });

            if (!dirPaths || !dirPaths.length) {
                console.log("[BatchGroupExporter] Export cancelled: No directory selected.");
                return;
            }
            
            cfg.dir = dirPaths[0];
            saveConfig(cfg);
            executeBatch(dirPaths[0]);

        } catch (e) {
            console.warn("[BatchGroupExporter] Native dialog failed. Falling back to Blockbench Export UI.", e);
            
            Blockbench.export({
                type: `Batch Target Directory (${currentFormat.toUpperCase()})`,
                extensions: [currentFormat],
                name: `Save_Here_To_Select_Folder.${currentFormat}`,
                content: 'dummy_content_to_prevent_error' 
            }, function(filePath) {
                if (!filePath) {
                    console.log("[BatchGroupExporter] Export cancelled: No directory selected.");
                    return;
                }
                
                let outDir = path.dirname(filePath);
                
                try {
                    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
                } catch(err) {}
                
                cfg.dir = outDir;
                saveConfig(cfg);
                executeBatch(outDir);
            });
        }
    }
})();
