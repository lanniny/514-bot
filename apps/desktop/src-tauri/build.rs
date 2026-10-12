fn main() {
    println!("cargo:rerun-if-changed=src/native-command-names.txt");
    // 权限自动生成是**单名单**驱动的：build.rs 只会为这里列出的命令生成
    // allow-/deny- 权限。所以名单 = 主窗口名单 ∪ 桌宠窗独占名单 ——
    // 后者由 capabilities/pet-window.json 引用，主窗口名单（ccswitch-native.json）
    // 不含它们，两个窗口的能力边界仍然分得清。
    let mut commands = include_str!("src/native-command-names.txt")
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    for command in include_str!("src/pet-owned-commands.txt")
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        if !commands.iter().any(|existing| existing == command) {
            commands.push(command.to_owned());
        }
    }
    let commands: &'static [&'static str] = Box::leak(
        commands
            .iter()
            .map(|command| Box::leak(command.clone().into_boxed_str()) as &'static str)
            .collect::<Vec<_>>()
            .into_boxed_slice(),
    );

    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(commands)),
    )
    .expect("failed to build Tauri application metadata");
}
