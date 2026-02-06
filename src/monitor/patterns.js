/**
 * Claude Code 状态检测模式
 * Author: CodePothunter
 * Version: 2.0.0 - 简化版本，只保留无法从 jsonl 获取的状态
 */

/**
 * 工具调用模式
 */
export const TOOL_CALL_PATTERNS = [
  'Using tool:', 'Tool:', 'Calling:',
  'Launching agent', 'Starting agent',
  'Running:', 'Executing:',
  'spawn', 'exec'
];

/**
 * 文件操作模式
 */
export const FILE_OPERATION_PATTERNS = [
  'Reading file:', 'Writing file:', 'Editing file:',
  'Created file:', 'Deleted file:',
  'Read:', 'Write:', 'Edit:',
  'reading', 'writing', 'editing'
];

/**
 * 测试执行模式
 */
export const TEST_PATTERNS = [
  'Running tests', 'Test:', 'pytest',
  'Testing:', 'Running test',
  'test suite', 'test coverage'
];

/**
 * 进度模式
 */
export const PROGRESS_PATTERNS = [
  'Step', 'step', 'Progress',
  'Working on', 'Processing',
  'Analyzing', 'Building',
  'Compiling', 'Installing'
];

/**
 * 完成模式
 */
export const COMPLETION_PATTERNS = [
  '✅', 'All done', 'Task completed',
  'Done', '完成', '已生成',
  'finished', 'completed',
  'Successfully', 'successfully'
];


export default {
  TOOL_CALL_PATTERNS,
  FILE_OPERATION_PATTERNS,
  TEST_PATTERNS,
  PROGRESS_PATTERNS,
  COMPLETION_PATTERNS,
};
