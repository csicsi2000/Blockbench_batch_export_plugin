(function() {
    let exportAction;
    let setDirAction;

    Plugin.register('batch_group_exporter', {
        title: 'Batch Group Exporter',
        author: 'Gemini',
        description: 'Exports all visible groups individually as files. Remembers the export folder per-model.',
        icon: 'archive',
        version: '1.0.3', // Bumped version
        variant: 'desktop', 
        
        onload() {
            // Standard Export Action
            exportAction = new Action('export_visible_groups', {
                name: 'Export Visible Groups (Batch)',
                description: 'Exports all visible folders individually with their direct meshes to the configured directory.',
                icon: 'drive_folder_upload',
                click: function() {
                    runExport(false); // false = try to use saved folder
                }
            });

            // Action to manually change the folder
            setDirAction = new Action('set_batch_export_folder', {
                name: 'Set Batch Export Folder...',
                description: 'Set the target folder for the Batch Group Exporter.',
                icon: 'create_new_folder',
                click: function() {
                    runExport(true); // true = force the prompt to appear
                }
            });

            MenuBar.addAction(exportAction, 'file.export');
            MenuBar.addAction(setDirAction, 'file.export');
            console.log("[BatchGroupExporter] Plugin loaded successfully.");
        },
        
        onunload() {
            exportAction.delete();
            setDirAction.delete();
            console.log("[BatchGroupExporter] Plugin unloaded.");
        }
    });

    function runExport(forcePrompt) {
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
        
        // Check if we have a saved directory in the current project
        let savedDir = Project ? Project.batch_export_dir : null;
        let needsPrompt = forcePrompt || !savedDir || !fs.existsSync(savedDir);

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

        if (groupsToExport.length === 0 && !forcePrompt) {
            console.warn("[BatchGroupExporter] No valid groups found to export.");
            Blockbench.showMessageBox({
                title: 'No Groups Found',
                message: 'No visible groups with direct mesh children were found to export.'
            });
            return;
        }

        // 2. Define the actual export execution logic
        function executeBatch(outDir) {
            if (groupsToExport.length === 0) {
                Blockbench.showQuickMessage('Export folder configured.');
                return;
            }

            console.log(`[BatchGroupExporter] Starting batch processing in directory: ${outDir}`);
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

                    console.log(`[BatchGroupExporter] Compiling OBJ for group '${group.name}'...`);
                    let content = Codecs.obj.compile();

                    // Safely extract OBJ text data depending on codec output type
                    let objData = typeof content === 'string' ? content : (content && content.obj ? content.obj : null);
                    
                    if (!objData) {
                        throw new Error("Codec returned empty or invalid data.");
                    }

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
                message: `Successfully exported ${exportedCount} groups to:\n${outDir}\n\nErrors encountered: ${errors}\n\n(Press Ctrl+Shift+I and check the console for logs)`
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
            if (Project) Project.batch_export_dir = dirPaths[0];
            executeBatch(dirPaths[0]);

        } catch (e) {
            console.warn("[BatchGroupExporter] Native dialog failed. Falling back to Blockbench Export UI.", e);
            
            Blockbench.export({
                type: 'Batch Target Directory',
                extensions: ['obj'],
                name: 'Save_Here_To_Select_Folder',
                content: 'dummy_content_to_prevent_error' // FIX: This prevents the undefined 'data' argument error
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
                if (Project) Project.batch_export_dir = outDir;
                executeBatch(outDir);
            });
        }
    }
})();