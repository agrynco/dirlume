# Self-hosted CI for Dirlume

## Goal and scope

As the repository maintainer, I want to keep Windows and Ubuntu CI, signed packages, and GitHub Release publishing when the source repository becomes private, without paying GitHub for runner compute.

Run one repository-scoped Linux x64 runner in Docker Compose and one Windows x64 runner in a dedicated Hyper-V VM. The Windows jobs need a signed-in desktop to launch WebView2, exercise Shell integrations, and test signed updater installs. A Windows service cannot supply that desktop. Keep the existing GitHub Release destination for authenticated use. Anonymous downloads and desktop updates require a separate distribution endpoint before the visibility change if they must remain available.

## Cutover

1. Review the [effects of changing visibility](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility). Private GitHub Free repositories lose [branch protection](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches). Keep access limited to trusted collaborators and check CI before merging release PRs.
2. Land the workflows on `main` and prepare the two runner machines. Before making the repository private, decide who should be able to download installers and receive updates. Dirlume currently uses this repository's public GitHub Releases URLs. After cutover, people with repository access can download releases in GitHub. Installed desktop clients use anonymous requests and will lose access to the update feed as soon as the repository is private. If public distribution is required, move the signed packages and feed to an approved public destination and ship the endpoint change while the old update feed still works.
3. Once the repository is private, register both runners under **Settings → Actions → Runners → New self-hosted runner**. Give each setup command a fresh registration token from this page. In **Settings → Secrets and variables → Actions → Variables**, set `DIRLUME_SELF_HOSTED` to `true` after both runners show **Idle**. Removing the variable routes new runs back to GitHub-hosted runners. Public repository runs always use GitHub-hosted runners.
4. Dispatch **CI and releases** on `prerelease` to build and test without publishing. A manual dispatch on `main` can publish. Dispatch **Install signed desktop updates** and **Sync Dirlume project status** and check the selected runner names in the run logs. For the next scheduled release, verify that Actions publishes the signed packages, checksums and `latest.json` on the merged commit.

GitHub currently charges nothing for self-hosted runner compute. GitHub Free includes $12 of hosted compute per month and 500 MB of Actions artifact storage. Private workflow artifacts expire after one day, including the build-matched source maps. Download needed maps before they expire. Use a [GitHub billing budget with Stop usage enabled](https://docs.github.com/en/billing/how-tos/set-up-budgets) if you have a payment method and want to prevent overages. Artifact uploads can fail when GitHub blocks additional storage, including the handoff to the release job. Self-hosted runs use the machines' local npm and Cargo caches. See [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

## Ubuntu 22.04 x64

Run from the repository root on a trusted machine with Docker and Compose v2 in Linux-container mode. Use a dedicated host or VM when available. Allocate enough space for Rust and both Linux bundles. Docker Desktop must be running if it supplies the Linux Docker engine.

```sh
docker compose -f ci/runners/compose.yml build
docker compose -f ci/runners/compose.yml run --rm runner register-dirlume-runner https://github.com/agrynco/dirlume
docker compose -f ci/runners/compose.yml up -d
docker compose -f ci/runners/compose.yml logs -f runner
```

The runner and its registration persist in the Compose volume. Keep that volume private. The container has no Docker socket, host directory mounts, or published ports. It uses the runner's auto-update and runs the updater's Debian installation fixture with container-local `sudo dpkg`. Start jobs only from trusted repository branches and collaborators. Stop the runner before planned maintenance and use `up -d --build` to refresh its build dependencies. Keep the same volume when recreating the container. To retire it, remove the runner in GitHub and then remove the dedicated Compose volume.

## Windows 11 x64

Use a licensed Windows guest and a Hyper-V-capable Windows host. Get an [official Windows 11 x64 ISO](https://www.microsoft.com/software-download/windows11). In elevated PowerShell on the host, run:

```powershell
.\ci\runners\windows\New-DirlumeRunnerVM.ps1 -IsoPath 'D:\ISO\Windows11.iso'
```

The script creates a generation 2 VM with Secure Boot, vTPM, four vCPUs, 12 GiB RAM, and a dynamically expanding 120 GiB virtual disk. Use `-SwitchName` if the host uses a different virtual switch. Connect with Hyper-V Manager, start the VM, install Windows and updates, then eject the ISO from the virtual DVD drive. Use a dedicated guest account and keep shared host drives and credentials out of the guest.

In the guest install:

- [Visual Studio 2022 Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with **Desktop development with C++**, MSVC x64 and a Windows SDK.
- Git for Windows with Git Bash on PATH, PowerShell 7 (`pwsh`), and x64 Python with `python -m pip` working. Restart the shell or sign in again after updating PATH.
- [Rustup x64](https://rustup.rs/) for the runner user with the MSVC host, and the [Evergreen WebView2 runtime](https://developer.microsoft.com/microsoft-edge/webview2/). The workflows provision Node 24 and select the Rust version from `rust-toolchain.toml`.

Copy the registration script into the guest. In PowerShell 7 under the dedicated runner account, run:

```powershell
.\Register-DirlumeRunner.ps1 -RepositoryUrl https://github.com/agrynco/dirlume
& "$env:LOCALAPPDATA\dirlume-runner\run.cmd"
```

Start `run.cmd` within the VM console and keep the guest desktop signed in and unlocked during builds. Closing the basic Hyper-V console connection leaves the guest signed in. After a reboot, sign in again and start the runner before starting CI. To start the listener automatically on sign-in, create a Task Scheduler task triggered by that account's logon and choose **Run only when user is logged on**.

## Acceptance checks

- [ ] Confirm public runs and private runs without the opt-in still use GitHub-hosted runners.
- [ ] Verify a private non-release dispatch reaches the Linux and Windows runners and runs the native tests and package builds, including the Windows desktop smoke checks.
- [ ] Verify the updater workflow on both runners, including Linux Debian installation and the Windows desktop restart.
- [ ] Verify project board reconciliation and the next signed GitHub Release, with access appropriate to the intended recipients.

**Ready for Dev: Yes.** Production activation requires Hyper-V administration, an installation ISO and licensed guest, GitHub repository administration, and a decision about public installer and update distribution.
