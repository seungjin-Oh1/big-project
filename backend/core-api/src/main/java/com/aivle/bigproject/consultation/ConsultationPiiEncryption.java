package com.aivle.bigproject.consultation;

import com.aivle.bigproject.common.TolerantCryptoConverter;
import java.sql.Array;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.sql.Types;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

// 암호화를 켜기 전에 저장된 상담 원문을 부팅할 때 한 번 암호문으로 올린다.
//
// 왜 앱 안에서 하는가 —
// 암호화 키가 앱에만 있어서 SQL로는 못 바꾼다. 그리고 팀원마다 로컬 DB가 따로 있어
// "각자 이 스크립트를 돌리세요"로는 반드시 누군가 빠진다. 켜는 순간 자동으로 맞춰지는
// 편이 확실하다.
//
// JPA가 아니라 JdbcTemplate으로 하는 이유: 엔티티로 읽으면 컨버터가 평문을 그대로
// 돌려주고(TolerantCryptoConverter), 값이 안 바뀌었으니 Hibernate가 UPDATE를 만들지
// 않는다. 평문인 채로 조용히 남는다.
//
// 여러 번 돌려도 안전하다 — 이미 암호문인 값은 건너뛴다. 바꿀 게 없으면 UPDATE도 없다.
@Component
@ConditionalOnProperty(name = "app.pii.encrypt-legacy-on-startup",
        havingValue = "true", matchIfMissing = true)
class ConsultationPiiEncryption implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(ConsultationPiiEncryption.class);

    private static final String SELECT_SQL = """
            SELECT id, input_text, opponent_name, call_input_texts, inperson_input_texts
            FROM consultation
            """;

    private static final String UPDATE_SQL = """
            UPDATE consultation
               SET input_text = ?, opponent_name = ?,
                   call_input_texts = ?, inperson_input_texts = ?
             WHERE id = ?
            """;

    private final JdbcTemplate jdbc;

    ConsultationPiiEncryption(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @Override
    public void run(ApplicationArguments args) {
        widenOpponentName();

        int encrypted = 0;
        for (Map<String, Object> row : jdbc.queryForList(SELECT_SQL)) {
            if (encryptRow(row)) {
                encrypted++;
            }
        }
        if (encrypted > 0) {
            log.info("상담 원문 암호화 마이그레이션: {}건 갱신", encrypted);
        }
    }

    // 암호문은 평문보다 길다. 이미 varchar(255)로 만들어진 DB에서는 긴 이름이 들어올 때
    // 저장이 실패하므로 엔티티에 적어 둔 길이(500)에 맞춘다. 이미 넓으면 아무 일도 없다.
    private void widenOpponentName() {
        try {
            jdbc.execute("ALTER TABLE consultation ALTER COLUMN opponent_name TYPE varchar(500)");
        } catch (RuntimeException e) {
            log.warn("opponent_name 길이 확장 실패(무시하고 진행): {}", e.getMessage());
        }
    }

    private boolean encryptRow(Map<String, Object> row) {
        Long id = ((Number) row.get("id")).longValue();
        String inputText = (String) row.get("input_text");
        String opponentName = (String) row.get("opponent_name");
        List<String> call = readArray(row.get("call_input_texts"));
        List<String> inperson = readArray(row.get("inperson_input_texts"));

        String nextInput = encryptIfPlain(inputText);
        String nextOpponent = encryptIfPlain(opponentName);
        List<String> nextCall = encryptIfPlain(call);
        List<String> nextInperson = encryptIfPlain(inperson);

        boolean changed = !java.util.Objects.equals(inputText, nextInput)
                || !java.util.Objects.equals(opponentName, nextOpponent)
                || !java.util.Objects.equals(call, nextCall)
                || !java.util.Objects.equals(inperson, nextInperson);
        if (!changed) {
            return false;
        }

        jdbc.update(connection -> {
            PreparedStatement ps = connection.prepareStatement(UPDATE_SQL);
            ps.setString(1, nextInput);
            ps.setString(2, nextOpponent);
            setTextArray(ps, 3, connection, nextCall);
            setTextArray(ps, 4, connection, nextInperson);
            ps.setLong(5, id);
            return ps;
        });
        return true;
    }

    private static String encryptIfPlain(String value) {
        if (value == null || value.isBlank() || TolerantCryptoConverter.isEncrypted(value)) {
            return value;
        }
        return TolerantCryptoConverter.encrypt(value);
    }

    private static List<String> encryptIfPlain(List<String> values) {
        if (values == null) {
            return null;
        }
        List<String> result = new ArrayList<>(values.size());
        for (String value : values) {
            result.add(encryptIfPlain(value));
        }
        return result;
    }

    private static List<String> readArray(Object value) {
        if (value == null) {
            return null;
        }
        try {
            Object raw = ((Array) value).getArray();
            return new ArrayList<>(java.util.Arrays.asList((String[]) raw));
        } catch (SQLException e) {
            throw new IllegalStateException("상담 원문 배열을 읽지 못했습니다", e);
        }
    }

    private static void setTextArray(PreparedStatement ps, int index,
            java.sql.Connection connection, List<String> values) throws SQLException {
        if (values == null) {
            ps.setNull(index, Types.ARRAY);
            return;
        }
        ps.setArray(index, connection.createArrayOf("text", values.toArray(new String[0])));
    }
}
