(function() {
    let exportAction;
    let settingsAction;

    Plugin.register('batch_group_exporter', {
        title: 'Batch Group Exporter',
        author: 'Gemini',
        description: 'Exports all visible groups individually as files. Includes a settings window to configure scale, directory, and rotation handling.',
        icon: 'archive',
        version: '1.2.0', // Bumped version for rotation handling options
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
                description: 'Configure scale, output folder, and rotations for the Batch Group Exporter.',
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
        
        // Migrate old v1.0.3 directory property if it exists
        if (Project.batch_export_dir && !Project.batch_export_config) {
            Project.batch_export_config = { dir: Project.batch_export_dir, scale: 1, rotationMode: 'keep_all' };
            delete Project.batch_export_dir;
        }

        // Migrate v1.1.1 resetRotation boolean to the new rotationMode string
        if (Project.batch_export_config && Project.batch_export_config.resetRotation !== undefined) {
            Project.batch_export_config.rotationMode = Project.batch_export_config.resetRotation ? 'reset_group' : 'keep_all';
            delete Project.batch_export_config.resetRotation;
        }

        // Ensure config exists
        Project.batch_export_config = Project.batch_export_config || { dir: '', scale: 1, rotationMode: 'keep_all' };
        if (!Project.batch_export_config.rotationMode) Project.batch_export_config.rotationMode = 'keep_all';
        
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

        // Migrate old v1.0.3 directory property if it exists
        if (Project.batch_export_dir && !Project.batch_export_config) {
            Project.batch_export_config = { dir: Project.batch_export_dir, scale: 1, rotationMode: 'keep_all' };
            delete Project.batch_export_dir;
        }

        // Migrate v1.1.1 resetRotation boolean to the new rotationMode string
        if (Project.batch_export_config && Project.batch_export_config.resetRotation !== undefined) {
            Project.batch_export_config.rotationMode = Project.batch_export_config.resetRotation ? 'reset_group' : 'keep_all';
            delete Project.batch_export_config.resetRotation;
        }

        Project.batch_export_config = Project.batch_export_config || { dir: '', scale: 1, rotationMode: 'keep_all' };
        if (!Project.batch_export_config.rotationMode) Project.batch_export_config.rotationMode = 'keep_all';
        
        let savedDir = Project.batch_export_config.dir;
        let currentScale = Project.batch_export_config.scale;
        let currentRotMode = Project.batch_export_config.rotationMode;
        let needsPrompt = !savedDir || !fs.existsSync(savedDir);

        // Helper function: Checks if an element AND all its parents are visible
        function isElementVisible(el) {
            if (el.visibility === false) return false;
            let parent = el.parent;
            while (parent && parent !== 'root') {
                if (parent.visibility === false) return false;
                parent = parent.parent;
            }
            return true;
        }

        // 1. Collect groups to export based on rules
        let groupsToExport = [];
        
        Group.all.forEach(group => {
            if (!isElementVisible(group)) return;

            // Find direct children that are meshes/cubes (not folders) and are visible
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

        // 2. Define the actual export execution logic
        function executeBatch(outDir) {
            console.log(`[BatchGroupExporter] Starting batch processing in directory: ${outDir}`);
            console.log(`[BatchGroupExporter] Using export scale multiplier: ${currentScale}`);
            console.log(`[BatchGroupExporter] Rotation handling mode: ${currentRotMode}`);
            console.log("[BatchGroupExporter] Caching current visibility and export states...");
            
            // Cache both visibility AND export status so the OBJ compiler respects our filtering
            let stateCache = new Map();
            Outliner.elements.forEach(el => stateCache.set(el.uuid, { vis: el.visibility, exp: el.export }));
            Group.all.forEach(g => stateCache.set(g.uuid, { vis: g.visibility, exp: g.export }));

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
                
                // Cache original rotations for this specific group's hierarchy to restore after compile
                let originalRotations = new Map();
                if (group.rotation) originalRotations.set(group.uuid, group.rotation.slice());
                children.forEach(child => {
                    if (child.rotation) originalRotations.set(child.uuid, child.rotation.slice());
                });

                try {
                    // Hide AND disable export for EVERYTHING
                    Outliner.elements.forEach(el => { el.visibility = false; el.export = false; });
                    Group.all.forEach(g => { g.visibility = false; g.export = false; });

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

                    // Option to neutralize rotation based on user settings
                    if (currentRotMode === 'reset_group' || currentRotMode === 'reset_all') {
                        if (group.rotation) group.rotation = [0, 0, 0];
                    }
                    if (currentRotMode === 'reset_all') {
                        children.forEach(child => {
                            if (child.rotation) child.rotation = [0, 0, 0];
                        });
                    }

                    // CRITICAL FIX: Force matrix update before compiling!
                    // Without this, the compiler uses stale rotations from the previously rendered frame.
                    Canvas.updateVisibility();

                    console.log(`[BatchGroupExporter] Compiling OBJ for group '${group.name}'...`);
                    let content = Codecs.obj.compile();

                    // Restore rotations immediately if we changed them
                    if (originalRotations.has(group.uuid)) {
                        group.rotation = originalRotations.get(group.uuid);
                    }
                    children.forEach(child => {
                        if (originalRotations.has(child.uuid)) {
                            child.rotation = originalRotations.get(child.uuid);
                        }
                    });

                    // Safely extract OBJ text data depending on codec output type
                    let objData = typeof content === 'string' ? content : (content && content.obj ? content.obj : null);
                    
                    if (!objData) {
                        throw new Error("Codec returned empty or invalid data.");
                    }

                    // Apply the configured scale to the OBJ vertices
                    objData = applyScaleToOBJ(objData, currentScale);

                    let safeName = group.name.replace(/[^a-zA-Z0-9_\-\ ]/gi, '_');
                    if (!safeName || safeName.trim() === "") safeName = 'group_' + group.uuid.substring(0, 5);
                    
                    let filePath = path.join(outDir, `${safeName}.obj`);

                    // Write files
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

            // Restore visibilities and export states
            console.log("[BatchGroupExporter] Restoring workspace visibility and export states...");
            Outliner.elements.forEach(el => {
                if (stateCache.has(el.uuid)) {
                    let state = stateCache.get(el.uuid);
                    el.visibility = state.vis;
                    el.export = state.exp;
                }
            });
            Group.all.forEach(g => {
                if (stateCache.has(g.uuid)) {
                    let state = stateCache.get(g.uuid);
                    g.visibility = state.vis;
                    g.export = state.exp;
                }
            });
            Canvas.updateVisibility();

            console.log(`[BatchGroupExporter] --- Process complete. Exported: ${exportedCount}, Errors: ${errors} ---`);
            Blockbench.showMessageBox({
                title: 'Batch Export Complete',
                message: `Successfully exported ${exportedCount} groups to:\n${outDir}\n\nScale applied: x${currentScale}\nErrors encountered: ${errors}\n\n(Press Ctrl+Shift+I and check the console for logs)`
            });
        }

        // 3. Check if we need to prompt the user or skip straight to execution
        if (!needsPrompt) {
            console.log("[BatchGroupExporter] Using saved directory:", savedDir);
            executeBatch(savedDir);
            return;
        }

        // 4. Ask the user for the destination directory
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
            
            // Save selection to the project so it persists in the .bbmodel save
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
                
                // Clean up the dummy file Blockbench generated
                try {
                    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
                } catch(err) {}
                
                // Save selection to the project so it persists in the .bbmodel save
                Project.batch_export_config.dir = outDir;
                executeBatch(outDir);
            });
        }
    }
})();