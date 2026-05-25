const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const pluginSource = fs.readFileSync(
    path.join(__dirname, '..', 'batch_group_exporter.js'),
    'utf8'
);

function loadPlugin({ project, storageEntries = {}, globals = {} } = {}) {
    const actions = {};
    const dialogs = [];
    const messages = [];
    const storage = new Map(Object.entries(storageEntries));
    const context = {
        console,
        require,
        Project: project || null,
        isApp: false,
        localStorage: {
            getItem(key) {
                return storage.has(key) ? storage.get(key) : null;
            },
            setItem(key, value) {
                storage.set(key, value);
            },
            removeItem(key) {
                storage.delete(key);
            }
        },
        Plugin: {
            register(id, definition) {
                context.plugin = { id, definition };
                definition.onload();
            }
        },
        Action: class {
            constructor(id, options) {
                actions[id] = options;
            }
            delete() {}
        },
        Dialog: class {
            constructor(options) {
                this.options = options;
                dialogs.push(this);
            }
            show() {}
            hide() {
                this.hidden = true;
            }
        },
        MenuBar: {
            addAction() {}
        },
        Blockbench: {
            showMessageBox(message) {
                messages.push(message);
            },
            showQuickMessage(message) {
                messages.push(message);
            },
            export() {}
        }
    };
    Object.assign(context, globals);

    vm.createContext(context);
    vm.runInContext(pluginSource, context, { filename: 'batch_group_exporter.js' });

    return { actions, dialogs, messages, storage, context };
}

test('settings reload a saved project directory after the project uuid becomes available', () => {
    const project = { uuid: undefined };
    const savedProjectConfig = {
        dir: 'D:/exports/project-a',
        scale: 2,
        rotationMode: 'keep_all',
        positionMode: 'keep_original',
        prefix: 'a_'
    };

    const harness = loadPlugin({
        project,
        storageEntries: {
            batch_exporter_cfg_last: JSON.stringify({
                dir: 'D:/exports/last',
                scale: 1,
                rotationMode: 'keep_all',
                positionMode: 'keep_original',
                prefix: ''
            }),
            batch_exporter_cfg_project_a: JSON.stringify(savedProjectConfig)
        }
    });

    harness.actions.batch_export_settings.click();
    assert.equal(harness.dialogs[0].options.form.outDir.value, '');

    project.uuid = 'project_a';
    harness.actions.batch_export_settings.click();

    assert.equal(
        harness.dialogs[1].options.form.outDir.value,
        savedProjectConfig.dir
    );
});

test('saving while project uuid is unavailable does not write an undefined project key', () => {
    const project = { uuid: undefined };
    const harness = loadPlugin({ project });

    harness.actions.batch_export_settings.click();
    assert.equal(harness.dialogs[0].options.form.exportFormat.value, 'obj');

    harness.dialogs[0].options.onConfirm.call(harness.dialogs[0], {
        scale: 1,
        positionMode: 'keep_original',
        rotationMode: 'keep_all',
        exportFormat: 'fbx',
        prefix: '',
        outDir: 'D:/exports/temporary'
    });

    assert.equal(harness.storage.has('batch_exporter_cfg_undefined'), false);
    assert.equal(project.batch_export_config.format, 'fbx');
});

test('settings do not reuse another project directory after a project uuid change', () => {
    const project = { uuid: 'project_a' };
    const harness = loadPlugin({
        project,
        storageEntries: {
            batch_exporter_cfg_project_a: JSON.stringify({
                dir: 'D:/exports/project-a',
                scale: 1,
                rotationMode: 'keep_all',
                positionMode: 'keep_original',
                prefix: ''
            }),
            batch_exporter_cfg_last: JSON.stringify({
                dir: '',
                scale: 1,
                rotationMode: 'keep_all',
                positionMode: 'keep_original',
                prefix: ''
            })
        }
    });

    harness.actions.batch_export_settings.click();
    assert.equal(harness.dialogs[0].options.form.outDir.value, 'D:/exports/project-a');

    project.uuid = 'project_b';
    harness.actions.batch_export_settings.click();

    assert.equal(harness.dialogs[1].options.form.outDir.value, '');
});

test('settings normalize invalid persisted scale values back to 1', () => {
    const project = { uuid: 'project_invalid_scale' };
    const harness = loadPlugin({
        project,
        storageEntries: {
            batch_exporter_cfg_project_invalid_scale: JSON.stringify({
                dir: 'D:/exports/project-invalid-scale',
                scale: 'not-a-number',
                rotationMode: 'keep_all',
                positionMode: 'keep_original',
                format: 'fbx',
                prefix: ''
            })
        }
    });

    harness.actions.batch_export_settings.click();

    assert.equal(harness.dialogs[0].options.form.scale.value, 1);
});

test('export updates scene matrices before reading group world rotation', () => {
    class MockVector3 {
        constructor(x = 0, y = 0, z = 0) {
            this.x = x;
            this.y = y;
            this.z = z;
        }
        clone() {
            return new MockVector3(this.x, this.y, this.z);
        }
        set(x, y, z) {
            this.x = x;
            this.y = y;
            this.z = z;
            return this;
        }
        copy(other) {
            this.x = other.x;
            this.y = other.y;
            this.z = other.z;
            return this;
        }
    }

    class MockQuaternion {
        constructor(x = 0, y = 0, z = 0, w = 1) {
            this.x = x;
            this.y = y;
            this.z = z;
            this.w = w;
        }
        clone() {
            return new MockQuaternion(this.x, this.y, this.z, this.w);
        }
        set(x, y, z, w) {
            this.x = x;
            this.y = y;
            this.z = z;
            this.w = w;
            return this;
        }
        copy(other) {
            this.x = other.x;
            this.y = other.y;
            this.z = other.z;
            this.w = other.w;
            return this;
        }
    }

    class MockGroup {}

    const exportDir = fs.mkdtempSync(path.join(
        require('node:os').tmpdir(),
        'batch-exporter-'
    ));
    const scene = {
        wasUpdatedBeforeWorldRead: false,
        updateMatrixWorld(force) {
            this.wasUpdatedBeforeWorldRead = force;
        },
        add(mesh) {
            mesh.parent = this;
        }
    };
    const child = {
        uuid: 'child',
        name: 'Child Cube',
        visibility: true,
        export: true,
        mesh: {
            position: new MockVector3(),
            rotation: new MockVector3(),
            quaternion: new MockQuaternion(),
            parent: null,
            updateMatrixWorld() {}
        }
    };
    const group = new MockGroup();
    Object.assign(group, {
        uuid: 'group',
        name: 'Rotated Group',
        visibility: true,
        export: true,
        parent: 'root',
        children: [child],
        mesh: {
            position: new MockVector3(),
            rotation: new MockVector3(),
            quaternion: new MockQuaternion(),
            parent: scene,
            updateMatrixWorld() {},
            getWorldPosition(out) {
                out.set(1, 2, 3);
            },
            getWorldQuaternion(out) {
                group.readQuaternionAfterSceneUpdate = scene.wasUpdatedBeforeWorldRead === true;
                out.set(0, 0.7071, 0, 0.7071);
            }
        }
    });
    child.parent = group;

    const project = {
        uuid: 'rotation_project',
        batch_export_config: {
            dir: exportDir,
            scale: 1,
            rotationMode: 'keep_all',
            positionMode: 'keep_original',
            prefix: ''
        },
        batch_export_config_key: 'batch_exporter_cfg_rotation_project',
        elements: [child]
    };

    const harness = loadPlugin({
        project,
        globals: {
            isApp: true,
            Group: Object.assign(MockGroup, { all: [group] }),
            Canvas: {
                scene,
                updateVisibility() {}
            },
            THREE: {
                Vector3: MockVector3,
                Quaternion: MockQuaternion
            },
            Codecs: {
                obj: {
                    compile() {
                        return 'v 0 0 0';
                    }
                }
            }
        }
    });

    harness.actions.export_visible_groups.click();

    assert.equal(group.readQuaternionAfterSceneUpdate, true);
});

test('fbx format exports one fbx file per group using the ascii fbx codec', () => {
    class MockVector3 {
        constructor(x = 0, y = 0, z = 0) {
            this.x = x;
            this.y = y;
            this.z = z;
        }
        clone() {
            return new MockVector3(this.x, this.y, this.z);
        }
        set(x, y, z) {
            this.x = x;
            this.y = y;
            this.z = z;
            return this;
        }
        copy(other) {
            this.x = other.x;
            this.y = other.y;
            this.z = other.z;
            return this;
        }
    }

    class MockQuaternion {
        constructor(x = 0, y = 0, z = 0, w = 1) {
            this.x = x;
            this.y = y;
            this.z = z;
            this.w = w;
        }
        clone() {
            return new MockQuaternion(this.x, this.y, this.z, this.w);
        }
        set(x, y, z, w) {
            this.x = x;
            this.y = y;
            this.z = z;
            this.w = w;
            return this;
        }
        copy(other) {
            this.x = other.x;
            this.y = other.y;
            this.z = other.z;
            this.w = other.w;
            return this;
        }
    }

    class MockGroup {}

    const exportDir = fs.mkdtempSync(path.join(
        require('node:os').tmpdir(),
        'batch-exporter-fbx-'
    ));
    const scene = {
        updateMatrixWorld() {},
        add(mesh) {
            mesh.parent = this;
        }
    };
    const child = {
        uuid: 'child',
        name: 'Child Cube',
        visibility: true,
        export: true,
        mesh: {
            position: new MockVector3(),
            rotation: new MockVector3(),
            quaternion: new MockQuaternion(),
            parent: null,
            updateMatrixWorld() {}
        }
    };
    const group = new MockGroup();
    Object.assign(group, {
        uuid: 'group',
        name: 'Unreal Prop',
        visibility: true,
        export: true,
        parent: 'root',
        children: [child],
        mesh: {
            position: new MockVector3(),
            rotation: new MockVector3(),
            quaternion: new MockQuaternion(),
            parent: scene,
            updateMatrixWorld() {},
            getWorldPosition(out) {
                out.set(1, 2, 3);
            },
            getWorldQuaternion(out) {
                out.set(0, 0, 0, 1);
            }
        }
    });
    child.parent = group;

    const project = {
        uuid: 'fbx_project',
        batch_export_config: {
            dir: exportDir,
            scale: 2,
            rotationMode: 'keep_all',
            positionMode: 'keep_original',
            format: 'fbx',
            prefix: ''
        },
        batch_export_config_key: 'batch_exporter_cfg_fbx_project',
        elements: [child]
    };
    const compileCalls = [];

    const harness = loadPlugin({
        project,
        globals: {
            isApp: true,
            Group: Object.assign(MockGroup, { all: [group] }),
            Canvas: {
                scene,
                updateVisibility() {}
            },
            THREE: {
                Vector3: MockVector3,
                Quaternion: MockQuaternion
            },
            Codecs: {
                fbx: {
                    compile(options) {
                        compileCalls.push(options);
                        return '; FBX ascii content';
                    }
                }
            }
        }
    });

    harness.actions.export_visible_groups.click();

    const fbxPath = path.join(exportDir, 'Unreal Prop.fbx');
    assert.equal(fs.readFileSync(fbxPath, 'utf8'), '; FBX ascii content');
    assert.equal(compileCalls.length, 1);
    assert.equal(compileCalls[0].encoding, 'ascii');
    assert.equal(compileCalls[0].include_animations, false);
    assert.equal(compileCalls[0].embed_textures, false);
    assert.equal(compileCalls[0].scale, 8);
});

test('fbx export adds smoothing group data for unreal imports', () => {
    class MockVector3 {
        constructor(x = 0, y = 0, z = 0) {
            this.x = x;
            this.y = y;
            this.z = z;
        }
        clone() {
            return new MockVector3(this.x, this.y, this.z);
        }
        set(x, y, z) {
            this.x = x;
            this.y = y;
            this.z = z;
            return this;
        }
        copy(other) {
            this.x = other.x;
            this.y = other.y;
            this.z = other.z;
            return this;
        }
    }

    class MockQuaternion {
        constructor(x = 0, y = 0, z = 0, w = 1) {
            this.x = x;
            this.y = y;
            this.z = z;
            this.w = w;
        }
        clone() {
            return new MockQuaternion(this.x, this.y, this.z, this.w);
        }
        set(x, y, z, w) {
            this.x = x;
            this.y = y;
            this.z = z;
            this.w = w;
            return this;
        }
        copy(other) {
            this.x = other.x;
            this.y = other.y;
            this.z = other.z;
            this.w = other.w;
            return this;
        }
    }

    class MockGroup {}

    const exportDir = fs.mkdtempSync(path.join(
        require('node:os').tmpdir(),
        'batch-exporter-smoothing-'
    ));
    const scene = {
        updateMatrixWorld() {},
        add(mesh) {
            mesh.parent = this;
        }
    };
    const child = {
        uuid: 'child',
        name: 'Child Cube',
        visibility: true,
        export: true,
        mesh: {
            position: new MockVector3(),
            rotation: new MockVector3(),
            quaternion: new MockQuaternion(),
            parent: null,
            updateMatrixWorld() {}
        }
    };
    const group = new MockGroup();
    Object.assign(group, {
        uuid: 'group',
        name: 'Smoothing Prop',
        visibility: true,
        export: true,
        parent: 'root',
        children: [child],
        mesh: {
            position: new MockVector3(),
            rotation: new MockVector3(),
            quaternion: new MockQuaternion(),
            parent: scene,
            updateMatrixWorld() {},
            getWorldPosition(out) {
                out.set(1, 2, 3);
            },
            getWorldQuaternion(out) {
                out.set(0, 0, 0, 1);
            }
        }
    });
    child.parent = group;

    const project = {
        uuid: 'smoothing_project',
        batch_export_config: {
            dir: exportDir,
            scale: 1,
            rotationMode: 'keep_all',
            positionMode: 'keep_original',
            format: 'fbx',
            prefix: ''
        },
        batch_export_config_key: 'batch_exporter_cfg_smoothing_project',
        elements: [child]
    };
    const fbxWithoutSmoothing = [
        'Geometry: 123, "Geometry::Smoothing Prop", "Mesh" {',
        '\tPolygonVertexIndex: *6 {',
        '\t\ta: 0,1,-3,3,4,-6',
        '\t}',
        '\tGeometryVersion: 124',
        '\tLayerElementNormal: 0 {',
        '\t\tMappingInformationType: "ByPolygon"',
        '\t\tReferenceInformationType: "Direct"',
        '\t\tNormals: *6 {',
        '\t\t\ta: 0,0,1,0,1,0',
        '\t\t}',
        '\t}',
        '\tLayer: 0 {',
        '\t\tVersion: 100',
        '\t\tLayerElement1: {',
        '\t\t\tType: "LayerElementNormal"',
        '\t\t\tTypedIndex: 0',
        '\t\t}',
        '\t}',
        '}'
    ].join('\n');

    const harness = loadPlugin({
        project,
        globals: {
            isApp: true,
            Group: Object.assign(MockGroup, { all: [group] }),
            Canvas: {
                scene,
                updateVisibility() {}
            },
            THREE: {
                Vector3: MockVector3,
                Quaternion: MockQuaternion
            },
            Codecs: {
                fbx: {
                    compile() {
                        return fbxWithoutSmoothing;
                    }
                }
            }
        }
    });

    harness.actions.export_visible_groups.click();

    const fbxPath = path.join(exportDir, 'Smoothing Prop.fbx');
    const output = fs.readFileSync(fbxPath, 'utf8');
    assert.match(output, /LayerElementSmoothing: 0 \{/);
    assert.match(output, /Smoothing: \*2 \{/);
    assert.match(output, /\ba: 0,0\b/);
    assert.match(output, /Type: "LayerElementSmoothing"/);
});
