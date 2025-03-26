import { FlowEventType, EditorType, ProjectChangeInfo } from './ext-models';

const EventEmitter = require('events')

export const emitter = new EventEmitter();

export function emitData(
  editor_type: EditorType,
  flow_event_type: FlowEventType,
  project_change_info: ProjectChangeInfo | null = null,
  event: any = null) {

  switch (flow_event_type) {
    case FlowEventType.FOCUS:
    case FlowEventType.UNFOCUS:
    case FlowEventType.THEME:
      emitter.emit(
        'editor_flow_data',
        {
          editor_type,
          flow_event_type,
          project_change_info,
          event
        }
      );
      break;
    default:
      if (project_change_info) {
        emitter.emit(
          'editor_flow_data',
          {
            editor_type,
            flow_event_type,
            project_change_info,
            event
          }
        );
      }
  }
}