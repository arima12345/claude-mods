# phone-notify

Claude があなたを待っているときや、長い作業が終わったときに、スマホへ通知する mod です。ntfy（無料の通知サービス）を使います。

goal2 で長い作業を任せて席を外していても、止まったらすぐに気づけます。デスクトップアプリでは mod から OS の通知を送れないので、goal2 の「一時停止」や progress-panel の「利用枠 95%」の知らせも、この mod がスマホに転送します。

## 通知する場面

| 場面 | タイトルの例 | 本文の例 |
| --- | --- | --- |
| 承認待ち | 【claude-mods】入力待ち | Claude needs your permission to use Bash |
| 質問で止まった | 【claude-mods】質問があります | どちらの案で進めますか？ |
| 長い作業が終わった（初期設定では3分以上） | 【claude-mods】作業が終わりました | 12分かかりました |
| エラーで止まった | 【claude-mods】エラーで止まりました | overloaded |
| ほかの mod の知らせ | 【claude-mods】ゴール一時停止 | 同じ理由で3回続けて未達です |

- タイトルの【】には、セッションを開いたフォルダの名前が入ります。何本も並行していても、どのセッションの知らせかがわかります。
- サブエージェントの動き、自分で中断したターン、短い作業の終わりは通知しません。
- 同じ通知は、60秒以内なら続けて送りません。
- 通知の文面には、コードやファイルの中身、Claude の返事の本文は入れません。

通知を受け取ったら、スマホの Claude アプリ（Remote Control）を開けば、そのまま返事ができます。

## 準備

1. スマホに ntfy のアプリを入れる（iPhone・Android とも無料）
2. 推測されにくいトピック名を決めて、アプリで購読する（例：`arima-claude-7f3k9q`）。ほかのアプリで ntfy を使っている場合も、Claude 用に別のトピックにしておくと見分けやすく、Claude の通知だけをミュートすることもできます
3. Claude Code で `/plugin configure phone-notify@claude-mods` を実行し、トピック名を入れる
4. `/phone-notify` を実行して、テスト通知が届くことを確かめる

ntfy.sh の公開トピックは、名前を知られると誰でも読めます。気になる場合は、自分のサーバーで ntfy を動かして `server` を変えてください。

## 設定

| 項目 | 内容 | 初期値 |
| --- | --- | --- |
| `topic` | ntfy のトピック名（秘密の値として保存） | 空（未設定のあいだは送らない） |
| `server` | ntfy のサーバー | `https://ntfy.sh` |
| `doneAfterMinutes` | 作業の終わりを知らせる最短時間（分） | 3 |
| `notifyWaiting` | 入力待ち・質問を知らせる | オン |
| `notifyDone` | 作業の終わりを知らせる | オン |
| `notifyError` | エラーを知らせる | オン |
| `notifyMods` | ほかの mod の知らせを転送する | オン |

詳しい仕様は [SPEC.md](SPEC.md) にあります。

## インストール

Claude Code の入力欄で:

```
/plugin install phone-notify --marketplace arima12345/claude-mods
```

マーケットプレイスを追加するか聞かれたら `y`、続けてインストール先（スコープ）を選びます。デスクトップアプリでは、入力欄の横の + から Plugins を開き、Add marketplace に `arima12345/claude-mods` を入れてから Add plugin を選びます。

なお、組織が管理している Claude Code では、入力待ちとエラーのイベントは組織が許可した mod でしか動きません。
