// Variable and list monitors, adapted from TurboWarp/scaffolding. Lists are read-only.
// Slider changes are reported through onVariableInput instead of touching the VM directly,
// so the runner can record them.

const LABELS = {
    motion_xposition: 'x position',
    motion_yposition: 'y position',
    motion_direction: 'direction',
    sensing_username: 'username',
    looks_size: 'size',
    sensing_answer: 'answer',
    sensing_mousedown: 'mouse down?',
    sensing_mousex: 'mouse x',
    sensing_mousey: 'mouse y',
    sensing_loudness: 'loudness',
    sensing_timer: 'timer',
    sensing_dayssince2000: 'days since 2000',
    sound_volume: 'volume'
};

const CURRENT_LABELS = {
    year: 'year',
    month: 'month',
    date: 'date',
    dayofweek: 'day of week',
    hour: 'hour',
    minute: 'minute',
    second: 'second'
};

/** Stringify like scaffolding: handles circular structures and -0. */
const stringify = value => {
    if (typeof value === 'object' && value !== null) {
        const seen = new WeakSet();
        return JSON.stringify(value, (_, v) => {
            if (typeof v === 'object' && v !== null) {
                if (seen.has(v)) return Array.isArray(v) ? '[...]' : '{...}';
                seen.add(v);
            }
            return v;
        });
    }
    if (Object.is(value, -0)) {
        return '-0';
    }
    return `${value}`;
};

class Monitor {
    constructor (stage, monitor) {
        this.stage = stage;
        this.id = monitor.get('id');
        this.spriteName = monitor.get('spriteName');
        this.targetId = monitor.get('targetId');
        this.opcode = monitor.get('opcode');
        this.params = monitor.get('params');

        this.root = document.createElement('div');
        this.root.className = 'sc-monitor-root';
        this.root.dataset.opcode = this.opcode;
        stage.monitorOverlay.appendChild(this.root);
    }

    getLabel () {
        let label;
        if (this.opcode === 'data_variable') {
            label = this.params.VARIABLE;
        } else if (this.opcode === 'data_listcontents') {
            label = this.params.LIST;
        } else if (this.opcode === 'looks_costumenumbername') {
            label = `costume ${this.params.NUMBER_NAME}`;
        } else if (this.opcode === 'looks_backdropnumbername') {
            label = `backdrop ${this.params.NUMBER_NAME}`;
        } else if (this.opcode === 'sensing_current') {
            label = CURRENT_LABELS[this.params.CURRENTMENU.toLowerCase()];
        } else if (LABELS[this.opcode]) {
            label = LABELS[this.opcode];
        } else {
            const vmLabel = this.stage.vm.runtime.getLabelForOpcode(this.opcode);
            label = vmLabel ? vmLabel.label : this.opcode;
        }
        return this.spriteName ? `${this.spriteName}: ${label}` : label;
    }

    update (monitor) {
        this.visible = monitor.get('visible');
        this.root.style.transform = `translate(${Math.round(monitor.get('x'))}px, ${Math.round(monitor.get('y'))}px)`;
        this.root.style.display = this.visible ? '' : 'none';
    }
}

class VariableMonitor extends Monitor {
    constructor (stage, monitor) {
        super(stage, monitor);
        this.value = '';

        if (monitor.get('mode') === 'large') {
            this.valueElement = document.createElement('div');
            this.valueElement.className = 'sc-monitor-large-value sc-monitor-value-color';
            this.root.appendChild(this.valueElement);
            return;
        }

        const inner = document.createElement('div');
        inner.className = 'sc-monitor-inner';
        const valueRow = document.createElement('div');
        valueRow.className = 'sc-monitor-row';
        const label = document.createElement('div');
        label.className = 'sc-monitor-label';
        label.textContent = this.getLabel();
        this.valueElement = document.createElement('div');
        this.valueElement.className = 'sc-monitor-value sc-monitor-value-color';
        valueRow.append(label, this.valueElement);
        inner.appendChild(valueRow);

        if (monitor.get('mode') === 'slider') {
            const sliderRow = document.createElement('div');
            sliderRow.className = 'sc-monitor-row';
            this.slider = document.createElement('input');
            this.slider.className = 'sc-monitor-slider';
            this.slider.type = 'range';
            this.slider.min = monitor.get('sliderMin');
            this.slider.max = monitor.get('sliderMax');
            this.slider.step = monitor.get('isDiscrete') ? 1 : 0.01;
            this.slider.disabled = !stage.interactive;
            this.slider.addEventListener('input', () => {
                // Monitors of local variables belong to the original sprite.
                const target = this.targetId ? this.stage.vm.runtime.getTargetById(this.targetId) : null;
                this.stage.onInput({
                    type: 'variable',
                    target: target && !target.isStage ? target.getName() : null,
                    id: this.id,
                    value: +this.slider.value
                });
            });
            sliderRow.appendChild(this.slider);
            inner.appendChild(sliderRow);
        }
        this.root.appendChild(inner);
    }

    update (monitor) {
        super.update(monitor);
        if (!this.visible) return;
        let value = monitor.get('value');
        if (typeof value === 'number' && !Object.is(value, -0)) {
            value = Number(value.toFixed(6));
        }
        value = stringify(value);
        if (this.value !== value) {
            this.value = value;
            this.valueElement.textContent = value;
            if (this.slider) {
                this.slider.value = value;
            }
        }
    }
}

const ROW_HEIGHT = 24;

// Only the rows in view exist in the DOM, since lists can have hundreds of thousands of items.
class ListMonitor extends Monitor {
    constructor (stage, monitor) {
        super(stage, monitor);
        this.rows = new Map();
        this.value = [];
        this.scrollTop = 0;
        this.oldLength = -1;

        const label = document.createElement('div');
        label.className = 'sc-monitor-list-label';
        label.textContent = this.getLabel();

        const rowsOuter = document.createElement('div');
        rowsOuter.className = 'sc-monitor-rows-outer';
        this.rowsInner = document.createElement('div');
        this.rowsInner.className = 'sc-monitor-rows-inner';
        this.rowsInner.addEventListener('scroll', () => {
            this.scrollTop = this.rowsInner.scrollTop;
            this.updateValue(this.value);
        }, {passive: true});
        this.endPoint = document.createElement('div');
        this.endPoint.className = 'sc-monitor-rows-endpoint';
        this.emptyLabel = document.createElement('div');
        this.emptyLabel.className = 'sc-monitor-empty';
        this.emptyLabel.textContent = '(empty)';
        this.rowsInner.append(this.endPoint, this.emptyLabel);
        rowsOuter.appendChild(this.rowsInner);

        const footer = document.createElement('div');
        footer.className = 'sc-monitor-list-footer';
        this.footerText = document.createElement('div');
        this.footerText.className = 'sc-monitor-list-footer-text';
        footer.appendChild(this.footerText);

        this.root.append(label, rowsOuter, footer);
    }

    update (monitor) {
        super.update(monitor);
        if (!this.visible) return;
        this.height = monitor.get('height') || 200;
        this.root.style.width = `${monitor.get('width') || 100}px`;
        this.root.style.height = `${this.height}px`;
        this.updateValue(monitor.get('value'));
    }

    createRow (index) {
        const root = document.createElement('div');
        root.className = 'sc-monitor-row-root';
        root.style.transform = `translateY(${index * ROW_HEIGHT}px)`;
        const indexEl = document.createElement('div');
        indexEl.className = 'sc-monitor-row-index';
        indexEl.textContent = index + 1;
        const valueOuter = document.createElement('div');
        valueOuter.className = 'sc-monitor-row-value-outer';
        const valueInner = document.createElement('div');
        valueInner.className = 'sc-monitor-row-value-inner';
        valueOuter.appendChild(valueInner);
        root.append(indexEl, valueOuter);
        this.rowsInner.appendChild(root);
        const row = {root, valueInner, value: null};
        this.rows.set(index, row);
        return row;
    }

    updateValue (value) {
        this.value = value;
        if (value.length !== this.oldLength) {
            this.oldLength = value.length;
            this.footerText.textContent = `length ${value.length}`;
            this.endPoint.style.transform = `translateY(${value.length * ROW_HEIGHT}px)`;
            this.emptyLabel.style.display = value.length ? 'none' : '';
        }

        const startIndex = Math.max(0, Math.floor(this.scrollTop / ROW_HEIGHT) - 5);
        const endIndex = Math.min(value.length - 1, Math.ceil((this.scrollTop + this.height) / ROW_HEIGHT) + 3);
        for (const [index, row] of this.rows) {
            if (index < startIndex || index > endIndex) {
                row.root.remove();
                this.rows.delete(index);
            }
        }
        for (let i = startIndex; i <= endIndex; i++) {
            const row = this.rows.get(i) || this.createRow(i);
            const text = stringify(value[i]);
            if (row.value !== text) {
                row.value = text;
                row.valueInner.textContent = text;
            }
        }
    }
}

export const updateMonitors = (stage, monitors) => {
    for (const monitorData of monitors.valueSeq()) {
        const id = monitorData.get('id');
        let monitor = stage.monitors.get(id);
        if (!monitor) {
            // Hidden monitors are only created once they are first shown.
            if (!monitorData.get('visible')) continue;
            monitor = monitorData.get('mode') === 'list' ?
                new ListMonitor(stage, monitorData) :
                new VariableMonitor(stage, monitorData);
            stage.monitors.set(id, monitor);
        }
        monitor.update(monitorData);
    }
};
