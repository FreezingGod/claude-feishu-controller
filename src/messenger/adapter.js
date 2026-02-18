/**
 * 消息适配器接口定义
 * Author: CodePothunter
 * Version: 1.0.0
 */

/**
 * MessengerAdapter 基础接口
 * 所有消息适配器都应该实现这个接口
 */
export class MessengerAdapter {
  constructor() {
    // 默认消息长度限制（飞书）
    this.maxMessageLength = 15000;
    this.splitThreshold = 12000;
  }

  /**
   * 发送文本消息
   * @param {string} text - 消息文本（支持 Markdown）
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async sendText(text) {
    throw new Error('sendText must be implemented');
  }

  /**
   * 发送卡片消息
   * @param {string} title - 卡片标题
   * @param {string} content - 卡片内容
   * @param {Array} buttons - 按钮列表
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async sendCard(title, content, buttons = []) {
    throw new Error('sendCard must be implemented');
  }

  /**
   * 发送状态更新
   * @param {string} status - 状态类型
   * @param {string} message - 状态消息
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async sendStatus(status, message) {
    return this.sendText(message);
  }

  /**
   * 发送错误通知
   * @param {string} error - 错误消息
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async sendError(error) {
    return this.sendText(`❌ ${error}`);
  }

  /**
   * 发送成功通知
   * @param {string} message - 成功消息
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async sendSuccess(message) {
    return this.sendText(`✅ ${message}`);
  }
}

export default MessengerAdapter;
