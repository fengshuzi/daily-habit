const { Plugin, ItemView, Modal, Notice, TFile } = require('obsidian');

// 辅助函数：格式化本地日期为 YYYY-MM-DD（避免 UTC 时区问题）
function formatLocalDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// 习惯记录解析器
class HabitParser {
    constructor(config) {
        this.config = config;
    }

    // 解析单行习惯打卡记录
    parseRecord(line, fileDate) {
        const { habits, habitPrefix } = this.config;
        
        // 检查是否包含标签前缀
        if (!line.includes(habitPrefix)) {
            return null;
        }

        // 创建习惯关键词列表
        const habitKeys = Object.keys(habits).sort((a, b) => b.length - a.length);
        const matches = [];
        
        // 匹配每个习惯标签
        habitKeys.forEach(habitKey => {
            const tagPattern = new RegExp(`${habitPrefix}${habitKey}\\b`, 'gi');
            if (tagPattern.test(line)) {
                const habitName = habits[habitKey];
                matches.push({
                    date: fileDate,
                    habitKey: habitKey,
                    habitName: habitName,
                    rawLine: line.trim()
                });
            }
        });
        
        return matches.length > 0 ? matches : null;
    }

    // 解析文件内容
    parseFileContent(content, filePath) {
        const lines = content.split('\n');
        const records = [];
        
        // 从文件路径提取日期
        const dateMatch = filePath.match(/(\d{4}-\d{2}-\d{2})/);
        const fileDate = dateMatch ? dateMatch[1] : formatLocalDate(new Date());

        lines.forEach(line => {
            const lineRecords = this.parseRecord(line, fileDate);
            if (lineRecords) {
                records.push(...lineRecords);
            }
        });

        return records;
    }
}

// 习惯数据管理器
class HabitStorage {
    constructor(app, config) {
        this.app = app;
        this.config = config;
        this.parser = new HabitParser(config);
        
        // 缓存机制
        this.cache = {
            records: null,
            lastUpdate: null
        };
        
        this.cacheTimeout = 30 * 1000; // 30秒缓存
    }

    /**
     * 日记文件变化时调用（vault / metadataCache 事件），清除缓存
     * @returns 是否为日记文件且已清除缓存（用于决定是否刷新视图）
     */
    onFileChange(file) {
        if (file.path.startsWith(this.config.journalsPath + '/') && file.extension === 'md') {
            this.clearCache();
            return true;
        }
        return false;
    }
    
    isCacheValid() {
        if (!this.cache.records || !this.cache.lastUpdate) {
            return false;
        }
        
        const now = Date.now();
        if ((now - this.cache.lastUpdate) > this.cacheTimeout) {
            return false;
        }
        
        return true;
    }
    
    clearCache() {
        this.cache.records = null;
        this.cache.lastUpdate = null;
    }

    // 获取所有打卡记录
    async getAllRecords(forceRefresh = false) {
        if (forceRefresh) {
            this.clearCache();
        }
        
        if (this.isCacheValid()) {
            console.log('使用缓存的打卡记录');
            return this.cache.records;
        }
        
        console.log('重新加载打卡记录...');
        
        const { vault } = this.app;
        const records = [];
        
        // 获取所有日记文件
        const allFiles = vault.getMarkdownFiles().filter(file => 
            file.path.startsWith(this.config.journalsPath)
        );
        
        // 只保留日期格式的文件
        const datePattern = /\d{4}-\d{2}-\d{2}\.md$/;
        const dateFiles = allFiles.filter(file => datePattern.test(file.name));
        
        console.log(`总文件数: ${allFiles.length}，日期格式文件: ${dateFiles.length}`);
        
        // 批量处理
        const batchSize = 50;
        for (let i = 0; i < dateFiles.length; i += batchSize) {
            const batch = dateFiles.slice(i, i + batchSize);
            
            const batchPromises = batch.map(async (file) => {
                try {
                    const content = await vault.cachedRead(file);
                    return this.parser.parseFileContent(content, file.path);
                } catch (error) {
                    console.error(`读取文件 ${file.path} 失败:`, error);
                    return [];
                }
            });
            
            const batchResults = await Promise.all(batchPromises);
            batchResults.forEach(fileRecords => {
                records.push(...fileRecords);
            });
        }
        
        console.log(`总共找到 ${records.length} 条打卡记录`);
        
        // 更新缓存
        this.cache.records = records;
        this.cache.lastUpdate = Date.now();
        
        return records;
    }

    // 按日期范围筛选记录
    filterRecordsByDateRange(records, startDate, endDate) {
        return records.filter(record => {
            const recordDate = new Date(record.date);
            return recordDate >= new Date(startDate) && recordDate <= new Date(endDate);
        });
    }

    // 统计数据
    calculateStatistics(records) {
        const stats = {
            totalCheckins: records.length,
            habitStats: {},
            dailyStats: {},
            streaks: {}
        };

        // 按习惯统计
        records.forEach(record => {
            if (!stats.habitStats[record.habitKey]) {
                stats.habitStats[record.habitKey] = {
                    name: record.habitName,
                    count: 0,
                    dates: []
                };
            }
            stats.habitStats[record.habitKey].count += 1;
            if (!stats.habitStats[record.habitKey].dates.includes(record.date)) {
                stats.habitStats[record.habitKey].dates.push(record.date);
            }

            // 按日期统计
            if (!stats.dailyStats[record.date]) {
                stats.dailyStats[record.date] = {
                    habits: [],
                    count: 0
                };
            }
            if (!stats.dailyStats[record.date].habits.includes(record.habitKey)) {
                stats.dailyStats[record.date].habits.push(record.habitKey);
                stats.dailyStats[record.date].count += 1;
            }
        });

        // 计算连续打卡天数
        Object.keys(stats.habitStats).forEach(habitKey => {
            const dates = stats.habitStats[habitKey].dates.sort();
            stats.streaks[habitKey] = this.calculateStreak(dates);
        });

        return stats;
    }
    
    // 计算连续打卡天数
    calculateStreak(dates) {
        if (dates.length === 0) return 0;
        
        const today = formatLocalDate(new Date());
        const sortedDates = dates.sort().reverse();
        
        // 如果今天没打卡，返回0
        if (sortedDates[0] !== today) {
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            const yesterdayStr = formatLocalDate(yesterday);
            
            // 如果昨天也没打卡，连续天数为0
            if (sortedDates[0] !== yesterdayStr) {
                return 0;
            }
        }
        
        let streak = 1;
        for (let i = 1; i < sortedDates.length; i++) {
            const currentDate = new Date(sortedDates[i]);
            const prevDate = new Date(sortedDates[i - 1]);
            const diffDays = Math.floor((prevDate - currentDate) / (1000 * 60 * 60 * 24));
            
            if (diffDays === 1) {
                streak++;
            } else {
                break;
            }
        }
        
        return streak;
    }
}

// 习惯配置模态框
class HabitConfigModal extends Modal {
    constructor(app, plugin) {
        super(app);
        this.plugin = plugin;
        this.appName = plugin.config.appName || '掌控习惯';
        this.habits = { ...plugin.config.habits };
        this.currentTab = 'basic';
    }

    onOpen() {
        const appName = this.plugin.config.appName || '掌控习惯';
        this.titleEl.setText(`${appName}配置`);
        
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('habit-config-modal');

        this.renderTabs(contentEl);
        this.contentArea = contentEl.createDiv('config-content');
        this.renderCurrentTab();

        const buttons = contentEl.createDiv('config-buttons');
        
        const cancelBtn = buttons.createEl('button', {
            text: '取消',
            cls: 'config-btn config-btn-cancel'
        });
        cancelBtn.onclick = () => this.close();

        const saveBtn = buttons.createEl('button', {
            text: '保存',
            cls: 'config-btn config-btn-save'
        });
        saveBtn.onclick = () => this.saveConfig();
    }

    renderTabs(container) {
        const tabsContainer = container.createDiv('config-tabs');
        
        const tabs = [
            { key: 'basic', label: '基础设置' },
            { key: 'habits', label: '习惯管理' }
        ];
        
        tabs.forEach(tab => {
            const tabBtn = tabsContainer.createEl('button', {
                text: tab.label,
                cls: `config-tab ${this.currentTab === tab.key ? 'active' : ''}`
            });
            tabBtn.onclick = () => this.switchTab(tab.key);
        });
    }

    switchTab(tabKey) {
        this.currentTab = tabKey;
        
        document.querySelectorAll('.config-tab').forEach(btn => {
            btn.classList.remove('active');
        });
        const tabIndex = tabKey === 'basic' ? 1 : 2;
        document.querySelector(`.config-tab:nth-child(${tabIndex})`).classList.add('active');
        
        this.renderCurrentTab();
    }

    renderCurrentTab() {
        this.contentArea.empty();
        
        if (this.currentTab === 'basic') {
            this.renderBasicTab();
        } else {
            this.renderHabitsTab();
        }
    }

    renderBasicTab() {
        const description = this.contentArea.createDiv('config-description');
        description.innerHTML = `
            <p>自定义应用名称，让习惯追踪更具个性化</p>
        `;

        const nameSection = this.contentArea.createDiv('config-section');
        nameSection.createEl('h3', { text: '应用名称' });
        
        const nameGroup = nameSection.createDiv('config-input-group');
        nameGroup.createEl('label', { text: '显示名称：' });
        const nameInput = nameGroup.createEl('input', {
            type: 'text',
            cls: 'config-text-input',
            value: this.appName,
            attr: { placeholder: '掌控习惯', maxlength: '20' }
        });
        nameInput.oninput = () => {
            this.appName = nameInput.value.trim() || '掌控习惯';
        };

        const previewSection = this.contentArea.createDiv('config-section');
        previewSection.createEl('h3', { text: '预览效果' });
        
        const previewBox = previewSection.createDiv('config-preview-box');
        const previewTitle = previewBox.createEl('div', { 
            cls: 'preview-title'
        });
        
        const updatePreview = () => {
            previewTitle.textContent = `✓ ${this.appName}`;
        };
        
        updatePreview();
        nameInput.oninput = () => {
            this.appName = nameInput.value.trim() || '掌控习惯';
            updatePreview();
        };
    }

    renderHabitsTab() {
        const description = this.contentArea.createDiv('config-description');
        description.innerHTML = `
            <p>配置习惯关键词和对应的中文名称</p>
            <p><strong>使用方法：</strong> 在日记中写 <code>#reading</code> 表示完成阅读打卡</p>
        `;

        this.habitList = this.contentArea.createDiv('habit-list');
        this.renderHabitList();

        const addButton = this.contentArea.createEl('button', {
            text: '+ 添加新习惯',
            cls: 'add-habit-btn'
        });
        addButton.onclick = () => this.addNewHabit();
    }

    renderHabitList() {
        this.habitList.empty();

        Object.entries(this.habits).forEach(([key, name]) => {
            const item = this.habitList.createDiv('habit-item');
            
            const keyInput = item.createEl('input', {
                type: 'text',
                cls: 'habit-key',
                value: key,
                placeholder: '关键词'
            });
            keyInput.maxLength = 20;

            const nameInput = item.createEl('input', {
                type: 'text',
                cls: 'habit-name',
                value: name,
                placeholder: '习惯名称'
            });
            nameInput.maxLength = 20;

            const deleteBtn = item.createEl('button', {
                text: '删除',
                cls: 'delete-habit-btn'
            });
            deleteBtn.onclick = () => this.deleteHabit(key);

            keyInput.oninput = () => this.updateHabit(key, keyInput.value, nameInput.value);
            nameInput.oninput = () => this.updateHabit(key, keyInput.value, nameInput.value);
        });
    }

    addNewHabit() {
        const newKey = `habit${Date.now()}`;
        this.habits[newKey] = '新习惯';
        this.renderHabitList();
    }

    deleteHabit(key) {
        delete this.habits[key];
        this.renderHabitList();
    }

    updateHabit(oldKey, newKey, name) {
        if (oldKey !== newKey) {
            delete this.habits[oldKey];
        }
        this.habits[newKey] = name;
    }

    async saveConfig() {
        try {
            const cleanAppName = this.appName.trim();
            if (!cleanAppName) {
                new Notice('应用名称不能为空');
                return;
            }

            const cleanHabits = {};
            for (const [key, name] of Object.entries(this.habits)) {
                const cleanKey = key.trim();
                const cleanName = name.trim();
                
                if (cleanKey && cleanName) {
                    cleanHabits[cleanKey] = cleanName;
                }
            }

            if (Object.keys(cleanHabits).length === 0) {
                new Notice('至少需要一个习惯');
                return;
            }

            this.plugin.config.appName = cleanAppName;
            this.plugin.config.habits = cleanHabits;
            
            const configPath = `${this.plugin.manifest.dir}/config.json`;
            const adapter = this.app.vault.adapter;
            const configContent = JSON.stringify(this.plugin.config, null, 4);
            await adapter.write(configPath, configContent);

            this.plugin.storage.clearCache();
            
            new Notice('配置已保存，正在刷新...');
            this.close();
            
            const leaves = this.app.workspace.getLeavesOfType(HABIT_VIEW);
            for (const leaf of leaves) {
                await leaf.setViewState({ type: 'empty' });
            }
            
            setTimeout(async () => {
                await this.plugin.activateView();
                new Notice('配置已保存并刷新');
            }, 100);
        } catch (error) {
            console.error('保存配置失败:', error);
            new Notice('保存配置失败');
        }
    }
}

// 习惯追踪视图
const HABIT_VIEW = 'habit-tracker-view';

class HabitTrackerView extends ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
        this.currentRecords = [];
        this.currentStats = null;
        this.currentMonth = new Date();
    }

    getViewType() {
        return HABIT_VIEW;
    }

    getDisplayText() {
        return this.plugin.config.appName || '掌控习惯';
    }

    getIcon() {
        return 'check-circle';
    }

    async onOpen() {
        await this.render();
    }

    async onClose() {
        // 清理资源
    }

    async render() {
        const container = this.containerEl.children[1];
        container.empty();
        container.addClass('habit-tracker-view');

        this.renderHeader(container);
        this.renderTimeFilter(container);
        this.renderStats(container);
        this.renderHabitList(container);
        this.renderCheckInRecords(container);
        
        await this.loadAllRecords();
    }

    renderHeader(container) {
        const header = container.createDiv('habit-header');
        
        const appName = this.plugin.config.appName || '掌控习惯';
        header.createEl('h2', { text: `✓ ${appName}`, cls: 'habit-title' });
        
        const actions = header.createDiv('habit-actions');
        
        const refreshBtn = actions.createEl('button', {
            text: '刷新数据',
            cls: 'habit-btn'
        });
        refreshBtn.onclick = () => this.loadAllRecords(true);

        const configBtn = actions.createEl('button', {
            text: '配置习惯',
            cls: 'habit-btn'
        });
        configBtn.onclick = () => this.showConfigModal();
    }

    renderTimeFilter(container) {
        const filters = container.createDiv('time-filters');
        
        const timeRanges = [
            { label: '本周', key: 'thisWeek' },
            { label: '上周', key: 'lastWeek' },
            { label: '本月', key: 'thisMonth' },
            { label: '上月', key: 'lastMonth' }
        ];
        
        timeRanges.forEach(range => {
            const btn = filters.createEl('button', {
                text: range.label,
                cls: 'time-filter-btn'
            });
            btn.setAttribute('data-range', range.key);
            
            // 默认选中本月
            if (range.key === 'thisMonth') {
                btn.classList.add('active');
            }
            
            btn.onclick = () => this.applyTimeRange(range.key, btn);
        });
    }

    applyTimeRange(rangeKey, buttonEl) {
        const now = new Date();
        let startDate, endDate;
        
        switch (rangeKey) {
            case 'thisWeek':
                startDate = this.getWeekStart(now);
                endDate = this.getWeekEnd(now);
                break;
                
            case 'lastWeek':
                const lastWeek = new Date(now);
                lastWeek.setDate(lastWeek.getDate() - 7);
                startDate = this.getWeekStart(lastWeek);
                endDate = this.getWeekEnd(lastWeek);
                break;
                
            case 'thisMonth':
                startDate = new Date(now.getFullYear(), now.getMonth(), 1);
                endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);
                break;
                
            case 'lastMonth':
                startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
                endDate = new Date(now.getFullYear(), now.getMonth(), 0);
                break;
        }
        
        const startStr = this.formatDate(startDate);
        const endStr = this.formatDate(endDate);
        
        // 保存当前时间范围
        this.currentTimeRange = { startDate, endDate, rangeKey };
        
        // 筛选记录
        this.filteredRecords = this.plugin.storage.filterRecordsByDateRange(
            this.currentRecords, startStr, endStr
        );
        this.currentStats = this.plugin.storage.calculateStatistics(this.filteredRecords);
        
        // 更新按钮状态
        document.querySelectorAll('.time-filter-btn').forEach(btn => btn.classList.remove('active'));
        buttonEl.classList.add('active');
        
        this.updateStatsDisplay();
        this.updateHabitListDisplay();
        this.updateCheckInRecordsDisplay();
    }

    getWeekStart(date) {
        const d = new Date(date);
        const day = d.getDay();
        const diff = d.getDate() - day + (day === 0 ? -6 : 1);
        return new Date(d.setDate(diff));
    }
    
    getWeekEnd(date) {
        const d = new Date(date);
        const day = d.getDay();
        const diff = d.getDate() - day + (day === 0 ? 0 : 7);
        return new Date(d.setDate(diff));
    }
    
    formatDate(date) {
        return formatLocalDate(date);
    }

    renderStats(container) {
        this.statsContainer = container.createDiv('habit-stats');
        this.updateStatsDisplay();
    }

    renderHabitList(container) {
        this.habitListContainer = container.createDiv('habit-list-view');
        this.updateHabitListDisplay();
    }
    
    renderCheckInRecords(container) {
        const recordsSection = container.createDiv('checkin-records-section');
        recordsSection.createEl('h3', { text: '打卡记录', cls: 'section-title' });
        this.checkInRecordsContainer = recordsSection.createDiv('checkin-records-list');
        this.updateCheckInRecordsDisplay();
    }

    async loadAllRecords(forceRefresh = false) {
        try {
            if (forceRefresh) {
                new Notice('正在刷新打卡数据...');
            }
            
            this.currentRecords = await this.plugin.storage.getAllRecords(forceRefresh);
            
            // 默认显示本月数据
            const now = new Date();
            const startDate = new Date(now.getFullYear(), now.getMonth(), 1);
            const endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);
            const startStr = this.formatDate(startDate);
            const endStr = this.formatDate(endDate);
            
            // 保存当前时间范围
            this.currentTimeRange = { startDate, endDate, rangeKey: 'thisMonth' };
            
            this.filteredRecords = this.plugin.storage.filterRecordsByDateRange(
                this.currentRecords, startStr, endStr
            );
            this.currentStats = this.plugin.storage.calculateStatistics(this.filteredRecords);
            
            this.updateStatsDisplay();
            this.updateHabitListDisplay();
            this.updateCheckInRecordsDisplay();
            
            const message = forceRefresh 
                ? `已刷新并加载 ${this.currentRecords.length} 条打卡记录`
                : `已加载 ${this.currentRecords.length} 条打卡记录`;
            new Notice(message);
        } catch (error) {
            console.error('加载打卡记录失败:', error);
            new Notice('加载打卡记录失败');
        }
    }

    updateHabitListDisplay() {
        if (!this.habitListContainer) return;
        
        this.habitListContainer.empty();
        
        const { habits } = this.plugin.config;
        
        if (Object.keys(habits).length === 0) {
            this.habitListContainer.createDiv({ text: '请先配置习惯', cls: 'no-data' });
            return;
        }

        const habitStats = this.currentStats?.habitStats || {};
        const streaks = this.currentStats?.streaks || {};
        const dailyStats = this.currentStats?.dailyStats || {};
        
        // 获取最近7天的日期
        const last7Days = this.getLast7Days();
        
        // 为每个配置的习惯创建一行（即使没有打卡记录）
        Object.entries(habits)
            .sort(([keyA], [keyB]) => {
                const countA = habitStats[keyA]?.count || 0;
                const countB = habitStats[keyB]?.count || 0;
                return countB - countA;
            })
            .forEach(([habitKey, habitName]) => {
                const data = habitStats[habitKey] || { name: habitName, count: 0, dates: [] };
                const habitRow = this.habitListContainer.createDiv('habit-row');
                
                // 习惯信息
                const habitInfo = habitRow.createDiv('habit-row-info');
                
                const habitNameEl = habitInfo.createDiv('habit-row-name');
                habitNameEl.textContent = data.name;
                
                const habitMeta = habitInfo.createDiv('habit-row-meta');
                
                const streak = streaks[habitKey] || 0;
                if (streak > 0) {
                    habitMeta.createDiv({ text: `🔥 ${streak}天`, cls: 'habit-row-streak' });
                }
                
                habitMeta.createDiv({ text: `${data.count}次`, cls: 'habit-row-count' });
                
                // 最近7天的打卡圆点
                const dotsContainer = habitRow.createDiv('habit-dots');
                
                last7Days.forEach(dateStr => {
                    const dotWrapper = dotsContainer.createDiv('habit-dot-wrapper');
                    
                    // 检查这一天是否有打卡
                    const dayStats = dailyStats[dateStr];
                    const isChecked = dayStats && dayStats.habits.includes(habitKey);
                    
                    // 创建复选框
                    const checkbox = dotWrapper.createEl('input', {
                        type: 'checkbox',
                        cls: 'habit-checkbox'
                    });
                    checkbox.checked = isChecked;
                    checkbox.title = dateStr;
                    
                    // 添加点击事件
                    checkbox.onchange = async () => {
                        await this.toggleHabitCheck(habitKey, dateStr, checkbox);
                    };
                });
            });
    }
    
    async toggleHabitCheck(habitKey, dateStr, checkboxElement) {
        try {
            const isCurrentlyChecked = checkboxElement.checked;
            const fileName = `${this.plugin.config.journalsPath}/${dateStr}.md`;
            let file = this.app.vault.getAbstractFileByPath(fileName);
            
            if (!file) {
                // 文件不存在，创建新文件
                const year = dateStr.split('-')[0];
                const month = dateStr.split('-')[1];
                const day = dateStr.split('-')[2];
                const dateTitle = `${year}年${parseInt(month)}月${parseInt(day)}日`;
                
                const content = `# ${dateTitle}\n\n`;
                await this.app.vault.create(fileName, content);
                file = this.app.vault.getAbstractFileByPath(fileName);
            }
            
            let content = await this.app.vault.read(file);
            
            const habitTag = `${this.plugin.config.habitPrefix}${habitKey}`;
            const habitName = this.plugin.config.habits[habitKey];
            const checkInLine = `- ${habitTag} ${habitName}打卡`;
            
            if (isCurrentlyChecked) {
                // 添加打卡：追加格式化的打卡记录
                if (!content.endsWith('\n')) {
                    content += '\n';
                }
                content += `${checkInLine}\n`;
                new Notice(`已添加 ${dateStr} 的打卡`);
            } else {
                // 取消打卡：删除包含该标签的打卡记录
                const lines = content.split('\n');
                const newLines = [];
                
                for (const line of lines) {
                    const trimmedLine = line.trim();
                    // 删除完整的打卡记录行
                    if (trimmedLine === checkInLine.trim() || trimmedLine === `- ${habitTag} ${habitName}打卡`) {
                        continue;
                    }
                    // 也删除只有标签的行（兼容旧格式）
                    else if (trimmedLine === habitTag) {
                        continue;
                    }
                    // 如果行中包含标签但不是完整的打卡记录，保留该行但删除标签
                    else if (line.includes(habitTag)) {
                        const tagPattern = new RegExp(`\\s*${habitTag}\\s*`, 'g');
                        const newLine = line.replace(tagPattern, ' ').replace(/\s+/g, ' ').trim();
                        if (newLine && newLine !== '-') {
                            newLines.push(line.replace(habitTag, '').trim());
                        }
                    } else {
                        newLines.push(line);
                    }
                }
                
                content = newLines.join('\n');
                new Notice(`已取消 ${dateStr} 的打卡`);
            }
            
            await this.app.vault.modify(file, content);
            
            // 清除缓存并重新加载数据
            this.plugin.storage.clearCache();
            await this.loadAllRecords(false);
            
        } catch (error) {
            console.error('切换打卡状态失败:', error);
            new Notice('操作失败，请重试');
            // 恢复复选框状态
            checkboxElement.checked = !checkboxElement.checked;
        }
    }
    
    getLast7Days() {
        const days = [];
        
        // 根据当前时间范围决定结束日期
        let endDate;
        if (this.currentTimeRange) {
            const { rangeKey, endDate: rangeEndDate } = this.currentTimeRange;
            
            // 本周和本月：使用今天作为结束日期
            if (rangeKey === 'thisWeek' || rangeKey === 'thisMonth') {
                endDate = new Date();
            } 
            // 上周和上月：使用时间范围的结束日期
            else {
                endDate = new Date(rangeEndDate);
            }
        } else {
            endDate = new Date();
        }
        
        // 从结束日期往前推7天
        for (let i = 6; i >= 0; i--) {
            const date = new Date(endDate);
            date.setDate(date.getDate() - i);
            days.push(formatLocalDate(date));
        }
        
        return days;
    }

    updateStatsDisplay() {
        if (!this.statsContainer) return;
        
        this.statsContainer.empty();
        
        if (!this.currentStats) {
            this.statsContainer.createDiv({ text: '暂无数据', cls: 'no-data' });
            return;
        }

        const { totalCheckins, habitStats } = this.currentStats;

        // 总览统计
        const overview = this.statsContainer.createDiv('stats-overview');
        
        const totalCard = overview.createDiv('stat-card total');
        totalCard.createDiv({ text: '总打卡次数', cls: 'stat-label' });
        totalCard.createDiv({ text: `${totalCheckins}`, cls: 'stat-value' });

        const habitsCard = overview.createDiv('stat-card habits');
        habitsCard.createDiv({ text: '追踪习惯数', cls: 'stat-label' });
        habitsCard.createDiv({ text: `${Object.keys(habitStats).length}`, cls: 'stat-value' });
    }
    
    updateCheckInRecordsDisplay() {
        if (!this.checkInRecordsContainer) return;
        
        this.checkInRecordsContainer.empty();
        
        if (!this.filteredRecords || this.filteredRecords.length === 0) {
            this.checkInRecordsContainer.createDiv({ text: '暂无打卡记录', cls: 'no-data' });
            return;
        }
        
        // 按日期分组
        const recordsByDate = {};
        this.filteredRecords.forEach(record => {
            if (!recordsByDate[record.date]) {
                recordsByDate[record.date] = [];
            }
            recordsByDate[record.date].push(record);
        });
        
        // 按日期倒序排列
        const sortedDates = Object.keys(recordsByDate).sort().reverse();
        
        sortedDates.forEach(date => {
            const dateGroup = this.checkInRecordsContainer.createDiv('checkin-date-group');
            
            // 日期标题
            const dateHeader = dateGroup.createDiv('checkin-date-header');
            const dateObj = new Date(date);
            const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
            const weekday = weekdays[dateObj.getDay()];
            
            const dateText = dateHeader.createEl('span', { 
                text: date, 
                cls: 'checkin-date-text clickable' 
            });
            dateHeader.createEl('span', { 
                text: weekday, 
                cls: 'checkin-weekday' 
            });
            
            // 添加点击事件，打开对应日期的日记
            dateText.onclick = async () => {
                await this.openDailyNote(date);
            };
            
            // 打卡记录
            const records = recordsByDate[date];
            const recordsContainer = dateGroup.createDiv('checkin-records');
            
            records.forEach(record => {
                const recordItem = recordsContainer.createDiv('checkin-record-item');
                
                // 习惯标签
                const habitTag = recordItem.createDiv('checkin-habit-tag');
                habitTag.textContent = record.habitName;
                
                // 原始内容（备注）
                const rawContent = recordItem.createDiv('checkin-raw-content');
                // 移除标签，只显示备注内容
                let content = record.rawLine.replace(`#${record.habitKey}`, '').trim();
                // 移除列表标记
                content = content.replace(/^-\s*/, '').trim();
                // 移除"xxx打卡"
                content = content.replace(`${record.habitName}打卡`, '').trim();
                
                if (content) {
                    rawContent.textContent = content;
                } else {
                    rawContent.textContent = '无备注';
                    rawContent.classList.add('no-note');
                }
            });
        });
    }
    
    async openDailyNote(dateStr) {
        try {
            const fileName = `${this.plugin.config.journalsPath}/${dateStr}.md`;
            const file = this.app.vault.getAbstractFileByPath(fileName);
            
            if (!file) {
                new Notice(`日记文件不存在: ${dateStr}`);
                return;
            }
            
            // 打开文件
            const leaf = this.app.workspace.getLeaf(false);
            await leaf.openFile(file);
            
        } catch (error) {
            console.error('打开日记失败:', error);
            new Notice('打开日记失败');
        }
    }

    showConfigModal() {
        new HabitConfigModal(this.app, this.plugin).open();
    }
}

// 主插件类
class HabitTrackerPlugin extends Plugin {
    async onload() {
        console.log('加载掌控习惯插件');

        await this.loadConfig();
        this.storage = new HabitStorage(this.app, this.config);

        this.registerView(HABIT_VIEW, (leaf) => new HabitTrackerView(leaf, this));

        const appName = this.config.appName || '掌控习惯';
        this.addRibbonIcon('check-circle', appName, () => {
            this.activateView();
        });

        this.addCommand({
            id: 'open-habit-tracker',
            name: `打开${appName}`,
            callback: () => this.activateView()
        });

        this.addCommand({
            id: 'refresh-habit-tracker',
            name: '刷新打卡数据',
            callback: () => this.refreshData()
        });

        // 只监听 metadataCache.changed：覆盖 Obsidian 内保存 + Alfred/外部写文件（重新解析时触发），避免多路监听导致列表重复刷新
        this.registerEvent(
            this.app.metadataCache.on('changed', (file) => {
                if (file instanceof TFile && this.storage.onFileChange(file)) {
                    this.refreshData();
                }
            })
        );
    }

    async onunload() {
        console.log('卸载掌控习惯插件');
        this.app.workspace.detachLeavesOfType(HABIT_VIEW);
    }

    async loadConfig() {
        try {
            const configPath = `${this.manifest.dir}/config.json`;
            const adapter = this.app.vault.adapter;
            
            if (await adapter.exists(configPath)) {
                const configContent = await adapter.read(configPath);
                this.config = JSON.parse(configContent);
                console.log('配置加载成功:', this.config);
            } else {
                console.log('配置文件不存在，使用默认配置');
                this.config = this.getDefaultConfig();
            }
        } catch (error) {
            console.error('加载配置失败:', error);
            this.config = this.getDefaultConfig();
        }
    }

    getDefaultConfig() {
        return {
            appName: "掌控习惯",
            habits: {
                "reading": "阅读",
                "sp": "运动",
                "en": "学习",
                "sleep": "早睡"
            },
            habitPrefix: "#",
            journalsPath: "journals"
        };
    }

    async activateView() {
        const { workspace } = this.app;
        
        let leaf = workspace.getLeavesOfType(HABIT_VIEW)[0];
        
        if (!leaf) {
            leaf = workspace.getLeaf('tab');
            await leaf.setViewState({
                type: HABIT_VIEW,
                active: true
            });
        }
        
        workspace.setActiveLeaf(leaf, { focus: true });
    }

    async refreshData() {
        const leaves = this.app.workspace.getLeavesOfType(HABIT_VIEW);
        for (const leaf of leaves) {
            if (leaf.view instanceof HabitTrackerView) {
                await leaf.view.loadAllRecords(true);
            }
        }
    }
}

module.exports = HabitTrackerPlugin;
