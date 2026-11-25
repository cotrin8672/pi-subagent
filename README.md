# pi-subagent

同じ Pi profile の Pig と Pi CLI で使える、読み取り専用のサブエージェント。次を実行し、対象のチャットをリロードする。

```sh
pi install git:github.com/cotrin8672/pi-subagent@v1.0.0
```

既存の `@ogulcancelik/pi-codex-subagents` とツール名が重なるため同時に有効化しない。既存の履歴や設定は自動で変更しない。

親に「AとBを別々のサブエージェントで調べて」と依頼すると、各子が独立した会話で作業する。子には必要な前提を依頼文に含める。親は待たずに作業を続けられ、完了すると結果が親にだけ返る。

| ツール | 用途 |
|---|---|
| `spawn_agent({task_name,message})` | 子を起動する。親あたり同時4実行まで |
| `send_message({target,message})` | 実行中の子に指示を追加、または完了済みの子の会話を続ける |
| `wait_agent({targets?,timeout_ms?})` | 結果が必要なときだけ待つ。待機の取消は子を止めない |
| `interrupt_agent({target})` | この親の子だけを停止 |
| `list_agents({})` | 子の状態と結果の要約を確認 |

`/agents` で子の会話を閲覧できる。閲覧でモデルは動かず、編集内容も保存しない。永続セッションの子は親の履歴ディレクトリ内の `.subagents` にPi標準のJSONLとして保存する。親ランタイムの終了・リロードで実行は停止するが、履歴は残る。一時セッションの履歴はディスクに残さない。
