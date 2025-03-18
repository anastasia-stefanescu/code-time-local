import { commands, Disposable, window, workspace } from 'vscode';
import { TrackerManager } from './TrackerManager';
import { EditorFlow, EditorType, FlowEventType, ProjectChangeInfo, VSCodeInterface } from '@swdotcom/editor-flow';
import { configureSettings, showingConfigureSettingsPanel } from './ConfigManager';
import { getWorkspaceName, isPrimaryWindow, setItem } from '../Util';
import { checkWebsocketConnection } from '../websockets';

import { setTimeout } from 'timers';

export class ChangeStateManager {
  private static instance: ChangeStateManager;
  private disposable: Disposable;
  private tracker: TrackerManager;

  constructor() {
    let subscriptions: Disposable[] = [];

    this.tracker = TrackerManager.getInstance(); //Initializes TrackerManager (handles tracking actions).

    const iface: VSCodeInterface = {
      disposable: Disposable,
      window: window,
      workspace: workspace,
    };

    //Sets up the editorFlow instance and listens for editor_flow_data events. 
    //The events can be file saves, focus changes, theme changes, and user metrics (KPM).
    const editorFlow: EditorFlow = EditorFlow.getInstance(EditorType.VSCODE, iface);
    const emitter: any = editorFlow.getEmitter();

    emitter.on('editor_flow_data', (data: any) => {
      switch (data.flow_event_type) {
        case FlowEventType.SAVE: //saved file
          this.fileSaveHandler(data.event);
          break;
        case FlowEventType.UNFOCUS: //unfocused
          this.windowStateChangeHandler(data.event);
          break;
        case FlowEventType.FOCUS:
          this.windowStateChangeHandler(data.event);
          break;
        case FlowEventType.THEME:
          this.themeKindChangeHandler(data.event);
          break;
        case FlowEventType.KPM:
          // get the project_change_info attribute and post it
          this.kpmHandler(data.project_change_info);
          break;
      }
    });

    this.disposable = Disposable.from(...subscriptions);
    //cleans up the resources by disposing of the Disposable instance.

  }

  static getInstance(): ChangeStateManager {
    if (!ChangeStateManager.instance) {
      ChangeStateManager.instance = new ChangeStateManager();
    }

    return ChangeStateManager.instance;
  }

  private kpmHandler(projectChangeInfo: ProjectChangeInfo) {
    this.tracker.trackCodeTimeEvent(projectChangeInfo);
  }

  private fileSaveHandler(event: any) {
    this.tracker.trackEditorAction('file', 'save', event);
  }

  private windowStateChangeHandler(event: any) {
    if (event.focused) { //If the editor window has just gained focus 
      this.tracker.trackEditorAction('editor', 'focus');  //log an editor focus event,
      setItem('vscode_primary_window', getWorkspaceName()); //stores the workspace name 
      //as the primary window identifier. This could help keep track of which window is currently "active" in multi-window setups.
      // check if the websocket connection is stale
      checkWebsocketConnection(); // verify that the websocket connection (possibly used for real-time updates or data syncing) is still active.
    } else if (isPrimaryWindow() && event.active) {
      //editor window loses focus and meets the criteria of being the primary window
      this.tracker.trackEditorAction('editor', 'unfocus'); //  log that the primary editor window has lost focus
    }
  }

  private themeKindChangeHandler(event: any) {
    // let the sidebar know the new current color kind
    setTimeout(() => {
      commands.executeCommand('codetime.refreshCodeTimeView');
      if (showingConfigureSettingsPanel()) {
        setTimeout(() => {
          configureSettings();
        }, 500);
      }
    }, 150);
  }

  public dispose() {
    this.disposable.dispose();
  }
}
