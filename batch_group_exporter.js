(function() {
    let exportAction;
    let settingsAction;

    Plugin.register('batch_group_exporter', {
        title: 'Batch Group Exporter',
        author: 'Gemini',
        description: 'Exports all visible groups individually as files. Includes a settings window to configure scale, directory, rotation, and position handling.',
        icon: 'archive',
        version: '1.3.2', // Fixed memory leak/duplication bug caused by init()
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
                description: 'Configure scale, output folder, position, and rotations for the Batch Group Exporter.',
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

    // Function to physically scale the vertices inside the raw OBJ string
    function applyScaleToOBJ(objString, scale) {
        if (scale === 1 || !objString) return objString;
        let lines = objString.split('\n');
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith('v ')) {
                // Split by spaces, avoiding issues with double spaces
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
        
        if (Project.batch_export_dir && !Project.batch_export_config) {
            Project.batch_export_config = { dir: Project.batch_export_dir, scale: 1, rotationMode: 'keep_all', positionMode: 'keep_original' };
            delete Project.batch_export_dir;
        }

        if (Project.batch_export_config && Project.batch_export_config.resetRotation !== undefined) {
            Project.batch_export_config.rotationMode = Project.batch_export_config.resetRotation ? 'reset_group' : 'keep_all';
            delete Project.batch_export_config.resetRotation;
        }

        Project.batch_export_config = Project.batch_export_config || { dir: '', scale: 1, rotationMode: 'keep_all', positionMode: 'keep_original' };
        if (!Project.batch_export_config.rotationMode) Project.batch_export_config.rotationMode = 'keep_all';
        if (!Project.batch_export_config.positionMode) Project.batch_export_config.positionMode = 'keep_original';
        
        let settingsDialog = new Dialog({
            id: 'batch_exporter_settings',
            title: 'Batch Exporter Settings',
            form: {
                scale: {
                    label: 'Export Scale Multiplier',
                    type: 'number',
                    value: Project.batch_export_config.scale,
                    min: 0.001,
                    step: 0.1,
                    description: 'Changes the physical size of the exported meshes.'
                },
                positionMode: {
                    label: 'Position Handling',
                    type: 'select',
                    options: {
                        'keep_original': 'Keep Original Position (World coordinates)',
                        'center_origin': 'Center to Origin (Moves group pivot to 0,0,0)'
                    },
                    value: Project.batch_export_config.positionMode,
                    description: 'Should the exported meshes stay in their exact world location or center to the origin point?'
                },
                rotationMode: {
                    label: 'Rotation Handling',
                    type: 'select',
                    options: {
                        'keep_all': 'Keep All Rotations (Baked into mesh)',
                        'reset_group': 'Reset Group Rotation (Keep element rotations)',
                        'reset_all': 'Reset All Rotations (Unrotated raw meshes)'
                    },
                    value: Project.batch_export_config.rotationMode,
                    description: 'How to handle rotations. "Keep All" maintains Blockbench orientation.'
                },
                outDir: {
                    label: 'Export Directory',
                    type: 'text',
                    value: Project.batch_export_config.dir,
                    placeholder: 'Leave blank to be prompted during export...',
                    description: 'The target folder for the .obj files.'
                }
            },
            onConfirm: function(formData) {
                Project.batch_export_config.scale = parseFloat(formData.scale) || 1;
                Project.batch_export_config.positionMode = formData.positionMode;
                Project.batch_export_config.rotationMode = formData.rotationMode;
                Project.batch_export_config.dir = formData.outDir;
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

        if (Project.batch_export_dir && !Project.batch_export_config) {
            Project.batch_export_config = { dir: Project.batch_export_dir, scale: 1, rotationMode: 'keep_all', positionMode: 'keep_original' };
            delete Project.batch_export_dir;
        }
        if (Project.batch_export_config && Project.batch_export_config.resetRotation !== undefined) {
            Project.batch_export_config.rotationMode = Project.batch_export_config.resetRotation ? 'reset_group' : 'keep_all';
            delete Project.batch_export_config.resetRotation;
        }
        Project.batch_export_config = Project.batch_export_config || { dir: '', scale: 1, rotationMode: 'keep_all', positionMode: 'keep_original' };
        if (!Project.batch_export_config.rotationMode) Project.batch_export_config.rotationMode = 'keep_all';
        if (!Project.batch_export_config.positionMode) Project.batch_export_config.positionMode = 'keep_original';
        
        let savedDir = Project.batch_export_config.dir;
        let currentScale = Project.batch_export_config.scale;
        let currentPosMode = Project.batch_export_config.positionMode;
        let currentRotMode = Project.batch_export_config.rotationMode;
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

            if (!Codecs.obj) {
                console.error("[BatchGroupExporter] OBJ Codec not found for this project type.");
                Blockbench.showMessageBox({ title: 'Format Error', message: 'OBJ exporting is not available in this workspace format.'});
                return;
            }

            groupsToExport.forEach(item => {
                let group = item.group;
                let children = item.children;
                
                // Deep cache transforms for this specific group's hierarchy to restore after compile
                let localTransformCache = new Map();
                function cacheNodeTransforms(n) {
                    localTransformCache.set(n.uuid, {
                        rot: n.rotation ? n.rotation.slice() : undefined,
                        origin: n.origin ? n.origin.slice() : undefined,
                        from: n.from ? n.from.slice() : undefined,
                        to: n.to ? n.to.slice() : undefined,
                        // Safely clone custom mesh vertices if present
                        vertices: n.vertices ? JSON.parse(JSON.stringify(n.vertices)) : undefined
                    });
                    if (n.children) n.children.forEach(cacheNodeTransforms);
                }
                cacheNodeTransforms(group);

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

                    // APPLY POSITION OFFSET: Center to origin mathematically
                    if (currentPosMode === 'center_origin' && group.origin) {
                        let offset = [-group.origin[0], -group.origin[1], -group.origin[2]];
                        function shiftNode(n) {
                            if (n.origin) n.origin = [n.origin[0] + offset[0], n.origin[1] + offset[1], n.origin[2] + offset[2]];
                            if (n.from) n.from = [n.from[0] + offset[0], n.from[1] + offset[1], n.from[2] + offset[2]];
                            if (n.to) n.to = [n.to[0] + offset[0], n.to[1] + offset[1], n.to[2] + offset[2]];
                            
                            // Adjust actual Mesh vertices if element is a custom Mesh (not a Cube)
                            if (n.vertices) {
                                for (let key in n.vertices) {
                                    if (n.vertices[key] && n.vertices[key].length >= 3) {
                                        n.vertices[key][0] += offset[0];
                                        n.vertices[key][1] += offset[1];
                                        n.vertices[key][2] += offset[2];
                                    }
                                }
                            }
                            if (n.children) n.children.forEach(shiftNode);
                        }
                        shiftNode(group);
                    }

                    // APPLY ROTATION OVERRIDES
                    if (currentRotMode === 'reset_group' || currentRotMode === 'reset_all') {
                        if (group.rotation) group.rotation = [0, 0, 0];
                    }
                    if (currentRotMode === 'reset_all') {
                        function unrotateNode(n) {
                            if (n.rotation) n.rotation = [0, 0, 0];
                            if (n.children) n.children.forEach(unrotateNode);
                        }
                        unrotateNode(group);
                    }

                    // --- CRITICAL THREE.JS MATRICES UPDATE ---
                    Canvas.updateVisibility();
                    
                    // Push updated transformations to Blockbench's engine variables safely
                    if (typeof Canvas.updateAllBones === 'function') Canvas.updateAllBones();
                    if (typeof Canvas.updatePositions === 'function') Canvas.updatePositions();
                    
                    // Force the internal Three.js scene graph to immediately process the new math.
                    if (Canvas.scene) {
                        Canvas.scene.updateMatrixWorld(true);
                    }
                    // ------------------------------------------

                    console.log(`[BatchGroupExporter] Compiling OBJ for group '${group.name}'...`);
                    let content = Codecs.obj.compile();

                    // RESTORE TRANSFORMS IMMEDIATELY
                    function restoreNodeTransforms(n) {
                        if (localTransformCache.has(n.uuid)) {
                            let state = localTransformCache.get(n.uuid);
                            if (state.rot && n.rotation) n.rotation = state.rot.slice();
                            if (state.origin && n.origin) n.origin = state.origin.slice();
                            if (state.from && n.from) n.from = state.from.slice();
                            if (state.to && n.to) n.to = state.to.slice();
                            
                            // Restore actual Mesh vertices
                            if (state.vertices && n.vertices) {
                                for (let key in state.vertices) {
                                    if (n.vertices[key]) {
                                        n.vertices[key][0] = state.vertices[key][0];
                                        n.vertices[key][1] = state.vertices[key][1];
                                        n.vertices[key][2] = state.vertices[key][2];
                                    }
                                }
                            }
                        }
                        if (n.children) n.children.forEach(restoreNodeTransforms);
                    }
                    restoreNodeTransforms(group);

                    let objData = typeof content === 'string' ? content : (content && content.obj ? content.obj : null);
                    if (!objData) throw new Error("Codec returned empty or invalid data.");

                    objData = applyScaleToOBJ(objData, currentScale);

                    let safeName = group.name.replace(/[^a-zA-Z0-9_\-\ ]/gi, '_');
                    if (!safeName || safeName.trim() === "") safeName = 'group_' + group.uuid.substring(0, 5);
                    
                    let filePath = path.join(outDir, `${safeName}.obj`);

                    fs.writeFileSync(filePath, objData);
                    if (content && typeof content === 'object' && content.mtl) {
                        fs.writeFileSync(filePath.replace('.obj', '.mtl'), content.mtl);
                    }

                    console.log(`[BatchGroupExporter] Successfully saved: ${filePath}`);
                    exportedCount++;

                } catch (err) {
                    console.error(`[BatchGroupExporter] Error exporting group '${group.name}':`, err);
                    errors++;
                }
            });

            // Restore global visibilities and export states
            console.log("[BatchGroupExporter] Restoring workspace visibility and export states...");
            allNodes.forEach(n => {
                if (stateCache.has(n.uuid)) {
                    let state = stateCache.get(n.uuid);
                    n.visibility = state.vis;
                    n.export = state.exp;
                }
            });
            
            // Final refresh of the workspace visual state safely
            Canvas.updateVisibility();
            if (typeof Canvas.updateAllBones === 'function') Canvas.updateAllBones();
            if (typeof Canvas.updatePositions === 'function') Canvas.updatePositions();
            if (Canvas.scene) Canvas.scene.updateMatrixWorld(true);

            console.log(`[BatchGroupExporter] --- Process complete. Exported: ${exportedCount}, Errors: ${errors} ---`);
            Blockbench.showMessageBox({
                title: 'Batch Export Complete',
                message: `Successfully exported ${exportedCount} groups to:\n${outDir}\n\nScale applied: x${currentScale}\nErrors encountered: ${errors}\n\n(Press Ctrl+Shift+I and check the console for logs)`
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
            
            Project.batch_export_config.dir = dirPaths[0];
            executeBatch(dirPaths[0]);

        } catch (e) {
            console.warn("[BatchGroupExporter] Native dialog failed. Falling back to Blockbench Export UI.", e);
            
            Blockbench.export({
                type: 'Batch Target Directory',
                extensions: ['obj'],
                name: 'Save_Here_To_Select_Folder',
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
                
                Project.batch_export_config.dir = outDir;
                executeBatch(outDir);
            });
        }
    }
})();