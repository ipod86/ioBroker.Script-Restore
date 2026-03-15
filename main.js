'use strict';
const utils = require('@iobroker/adapter-core');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const tar = require('tar');

class ScriptRestore extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 'script-restore' });
        this.on('ready', this.onReady.bind(this));
        this.on('message', this.onMessage.bind(this));
    }
    async onReady() {
        this.log.info('Adapter started. Using native Node.js operations and tar library.');
        this.tempDir = path.join(utils.getAbsoluteDefaultDataDir(), 'script-restore-tmp');
        try {
            if (!fsSync.existsSync(this.tempDir)) {
                await fs.mkdir(this.tempDir, { recursive: true });
            }
        } catch (err) {
            this.log.error('Could not create temp directory: ' + err.message);
        }
    }
    async onMessage(obj) {
        if (!obj || !obj.message) return;
        switch (obj.command) {
            case 'getLocalBackups':
                await this.handleGetLocalBackups(obj);
                break;
            case 'getScriptsFromBackup':
                await this.handleGetScriptsFromBackup(obj);
                break;
            case 'processUploadedBackup':
                await this.handleProcessUploadedBackup(obj);
                break;
            case 'importScript':
                await this.handleImportScript(obj);
                break;
        }
    }
    async handleGetLocalBackups(obj) {
        const backupPath = this.config.backupPath || '/opt/iobroker/backups';
        try {
            const files = await fs.readdir(backupPath);
            const backups = files
                .filter(f => (f.startsWith('javascripts') || f.startsWith('iobroker')) && (f.endsWith('.tar.gz') || f.endsWith('.gz')))
                .sort().reverse();
            this.sendTo(obj.from, obj.command, { backups }, obj.callback);
        } catch (err) {
            this.sendTo(obj.from, obj.command, { error: err.message }, obj.callback);
        }
    }
    async handleProcessUploadedBackup(obj) {
        const { filename, data } = obj.message;
        const uploadPath = path.join(this.tempDir, 'uploaded_' + filename);
        try {
            await fs.writeFile(uploadPath, Buffer.from(data, 'base64'));
            await this.extractAndSendScripts(uploadPath, obj);
            await fs.rm(uploadPath, { force: true });
        } catch (err) {
            this.sendTo(obj.from, obj.command, { error: err.message }, obj.callback);
        }
    }
    async handleGetScriptsFromBackup(obj) {
        const fullPath = path.join(this.config.backupPath || '/opt/iobroker/backups', obj.message.filename);
        await this.extractAndSendScripts(fullPath, obj);
    }
    async extractAndSendScripts(archivePath, obj) {
        try {
            const oldFiles = await fs.readdir(this.tempDir);
            for (const file of oldFiles) {
                await fs.rm(path.join(this.tempDir, file), { recursive: true, force: true });
            }
            await tar.x({
                file: archivePath,
                cwd: this.tempDir,
                filter: (p) => p.endsWith('.jsonl') || p.endsWith('.json')
            });
            let scripts = [];
            const files = await fs.readdir(this.tempDir);
            for (const file of files) {
                if (!file.endsWith('.jsonl') && !file.endsWith('.json')) continue;
                const content = await fs.readFile(path.join(this.tempDir, file), 'utf-8');
                if (file.endsWith('.jsonl')) {
                    content.split('\n').forEach(line => {
                        if (!line.trim()) return;
                        try {
                            const item = JSON.parse(line);
                            this.processItem(item.id || item._id, item.value || item.doc || item, scripts);
                        } catch (e) {}
                    });
                } else {
                    try {
                        const data = JSON.parse(content);
                        Object.entries(data).forEach(([k, v]) => this.processItem(k, v, scripts));
                    } catch (e) {}
                }
            }
            this.sendTo(obj.from, obj.command, { scripts }, obj.callback);
        } catch (err) {
            this.sendTo(obj.from, obj.command, { error: err.message }, obj.callback);
        }
    }
    processItem(key, val, scriptsList) {
        if (val && typeof val === 'object' && (val.type === 'script' || String(key).startsWith('script.js.'))) {
            if (['channel', 'device', 'folder', 'meta'].includes(val.type)) return;
            const c = val.common;
            if (!c || (!c.engineType && !c.source)) return;
            const raw = String(c.engineType || 'JS').toLowerCase();
            const sType = raw.includes('ts') ? 'TypeScript' : raw.includes('blockly') ? 'Blockly' : 'JS';
            scriptsList.push({
                name: (typeof c.name === 'object' ? c.name.de || c.name.en : c.name) || String(key).split('.').pop(),
                path: String(key).replace('script.js.', ''),
                type: sType,
                source: c.source || ''
            });
        }
    }
    async handleImportScript(obj) {
        const { path: sPath, source, type, name } = obj.message;
        try {
            const targetId = `script.js.restored.${sPath}`;
            await this.setForeignObjectAsync(targetId, {
                type: 'script',
                common: {
                    name: `${name} (Restored)`,
                    engineType: type === 'TypeScript' ? 'TypeScript/ts' : (type === 'Blockly' ? 'Blockly' : 'Javascript/js'),
                    source,
                    enabled: false,
                    engine: 'system.adapter.javascript.0'
                },
                native: {}
            });
            this.sendTo(obj.from, obj.command, { success: true }, obj.callback);
        } catch (err) {
            this.sendTo(obj.from, obj.command, { error: err.message }, obj.callback);
        }
    }
}
new ScriptRestore();
