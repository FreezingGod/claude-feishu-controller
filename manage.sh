#!/bin/bash
# Claude Feishu Controller 服务管理脚本

SERVICE_NAME="claude-feishu-controller"

show_help() {
    cat << EOF
Claude Feishu Controller 服务管理脚本

用法:
    $0 [命令]

命令:
    start       启动服务
    stop        停止服务
    restart     重启服务
    status      查看服务状态
    enable      开机自启
    disable     取消开机自启
    logs        查看实时日志
    logs-failed 查看错误日志
    reload      重载配置

示例:
    $0 start              # 启动服务
    $0 restart            # 重启服务
    $0 status             # 查看状态
    $0 logs               # 查看实时日志（Ctrl+C 退出）
    $0 logs | tail -n 50  # 查看最近50条日志

EOF
}

case "$1" in
    start)
        echo "🚀 启动 $SERVICE_NAME 服务..."
        sudo systemctl start $SERVICE_NAME.service
        echo "✅ 服务已启动"
        ;;

    stop)
        echo "🛑 停止 $SERVICE_NAME 服务..."
        sudo systemctl stop $SERVICE_NAME.service
        echo "✅ 服务已停止"
        ;;

    restart)
        echo "🔄 重启 $SERVICE_NAME 服务..."
        sudo systemctl restart $SERVICE_NAME.service
        echo "✅ 服务已重启"
        ;;

    status)
        echo "📊 查看 $SERVICE_NAME 服务状态..."
        sudo systemctl status $SERVICE_NAME.service --no-pager
        ;;

    enable)
        echo "🔑 设置 $SERVICE_NAME 服务开机自启..."
        sudo systemctl enable $SERVICE_NAME.service
        echo "✅ 已设置为开机自启"
        ;;

    disable)
        echo "🔕 取消 $SERVICE_NAME 服务开机自启..."
        sudo systemctl disable $SERVICE_NAME.service
        echo "✅ 已取消开机自启"
        ;;

    logs)
        echo "📝 查看 $SERVICE_NAME 服务实时日志（Ctrl+C 退出）..."
        sudo journalctl -u $SERVICE_NAME -f
        ;;

    logs-failed)
        echo "❌ 查看 $SERVICE_NAME 服务错误日志..."
        sudo journalctl -u $SERVICE_NAME -p err -n 50 --no-pager
        ;;

    reload)
        echo "🔃 重载 $SERVICE_NAME 服务配置..."
        sudo systemctl daemon-reload
        sudo systemctl reload $SERVICE_NAME.service 2>/dev/null || sudo systemctl restart $SERVICE_NAME.service
        echo "✅ 配置已重载"
        ;;

    *)
        show_help
        exit 1
        ;;
esac
